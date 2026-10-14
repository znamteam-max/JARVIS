import { and, eq, gt, inArray } from "drizzle-orm";
import { DateTime } from "luxon";

import { actionPlanSchema, type ActionPlan, type ActionPlanItem } from "@/ai/schemas";
import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import { getDb } from "@/db/client";
import {
  actionPlanItems,
  actionPlans,
  auditLog,
  plannerItems,
  reminderPolicies,
  reminderPolicyOccurrences,
  reminders,
} from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import type { MaterializedItem, MaterializedReminder } from "@/domain/types";
import { UserFacingError } from "@/lib/errors";
import { isHardManagementText } from "@/agent/hardManagementIntent";
import {
  nextRecurringOccurrence,
  recurringRuleMissingField,
} from "@/domain/recurringPolicySemantics";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import { findNextAvailableReminderSlot } from "@/services/reminderCollisionSpacing";
import { sanitizePlannerTitle } from "@/domain/titleSanitizer";

import { storePlanMemoryFacts } from "./memory";

export type StoredActionPlan = typeof actionPlans.$inferSelect;

export function shouldAutoCommitPlan(
  plan: ActionPlan,
  smartCommitMode: string | null | undefined,
): boolean {
  if (plan.intent !== "plan" || !plan.actions.length) return false;
  if (plan.actions.some((item) => item.metadata?.timeUnspecified === true)) return false;
  if (smartCommitMode === "confirm_all") return false;
  if (smartCommitMode === "auto_all_with_undo")
    return !plan.actions.some((item) => item.risk === "high");
  return (
    !plan.requiresConfirmation &&
    plan.confidence >= 0.75 &&
    plan.actions.every(
      (item) => !item.requiresConfirmation && item.risk !== "high" && item.confidence >= 0.72,
    )
  );
}

export async function createStoredActionPlan(params: {
  userId: string;
  sourceMessageId?: string | null;
  plan: ActionPlan;
  idempotencyKey: string;
  commitMode: string;
  ttlMinutes?: number;
  reminderPolicies?: AgentReminderPolicy[];
}) {
  assertPlanDoesNotContainManagementCommands(params.plan);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 60) * 60 * 1000);
  const [inserted] = await getDb()
    .insert(actionPlans)
    .values({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      status: "pending",
      summary: params.plan.summary,
      commitMode: params.commitMode,
      confidencePercent: Math.round(params.plan.confidence * 100),
      payload: {
        ...params.plan,
        reminderPolicies: params.reminderPolicies ?? [],
      },
      idempotencyKey: params.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing({ target: actionPlans.idempotencyKey })
    .returning();

  const planRecord = inserted ?? (await findActionPlanByIdempotencyKey(params.idempotencyKey));
  if (!planRecord) throw new Error("Action plan was not stored");

  if (inserted && params.plan.actions.length) {
    await getDb()
      .insert(actionPlanItems)
      .values(
        params.plan.actions.map((item, index) => ({
          actionPlanId: planRecord.id,
          userId: params.userId,
          sequence: index,
          actionType: item.actionType,
          payload: item,
        })),
      )
      .onConflictDoNothing();
  }

  return planRecord;
}

export async function commitStoredActionPlan(params: {
  actionPlanId: string;
  userId: string;
  timezone: string;
  now?: Date;
  reminderPolicies?: AgentReminderPolicy[];
}) {
  const now = params.now ?? new Date();
  return getDb()
    .transaction(async (tx) => {
      const [planRecord] = await tx
        .update(actionPlans)
        .set({
          status: "committed",
          confirmedAt: now,
          committedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(actionPlans.id, params.actionPlanId),
            eq(actionPlans.userId, params.userId),
            eq(actionPlans.status, "pending"),
            gt(actionPlans.expiresAt, now),
          ),
        )
        .returning();

      if (!planRecord) {
        const [existing] = await tx
          .select()
          .from(actionPlans)
          .where(
            and(eq(actionPlans.id, params.actionPlanId), eq(actionPlans.userId, params.userId)),
          )
          .limit(1);
        if (!existing) return { status: "not_found" as const };
        if (existing.status === "cancelled") return { status: "cancelled" as const };
        if (existing.status === "committed") return { status: "already_committed" as const };
        return { status: "expired" as const };
      }

      const payload = planRecord.payload as Record<string, unknown>;
      const plan = actionPlanSchema.parse(payload);
      const reminderPolicyProposals =
        params.reminderPolicies ??
        (Array.isArray(payload.reminderPolicies)
          ? (payload.reminderPolicies as AgentReminderPolicy[])
          : []);
      assertPlanDoesNotContainManagementCommands(plan);
      assertReminderPoliciesAreCompleteBeforeCommit(reminderPolicyProposals);
      const createdItems = [];
      const createdReminders: MaterializedReminder[] = [];
      const createdPolicies: Array<typeof reminderPolicies.$inferSelect> = [];
      const createdPolicyReminderIds: string[] = [];

      for (const [index, action] of plan.actions.entries()) {
        const materialized = materializeAction({
          action,
          timezone: params.timezone,
          now,
          actionPlanId: planRecord.id,
          sequence: index,
        });

        const [item] = await tx
          .insert(plannerItems)
          .values({
            userId: params.userId,
            kind: materialized.item.kind,
            title: materialized.item.title,
            description: materialized.item.description,
            location: materialized.item.location,
            timezone: materialized.item.timezone,
            startAt: materialized.item.startAt,
            endAt: materialized.item.endAt,
            dueAt: materialized.item.dueAt,
            category:
              typeof materialized.item.metadata.category === "string"
                ? materialized.item.metadata.category
                : categoryForItem(materialized.item.kind),
            visibility: materialized.item.kind === "recurring_task" ? "long_term" : "active",
            priority: materialized.item.priority,
            metadata: materialized.item.metadata,
          })
          .returning();

        if (!item) throw new UserFacingError("Не получилось создать запись плана.");
        createdItems.push(item);

        await tx
          .update(actionPlanItems)
          .set({ status: "committed", committedItemId: item.id, updatedAt: now })
          .where(
            and(
              eq(actionPlanItems.actionPlanId, planRecord.id),
              eq(actionPlanItems.sequence, index),
            ),
          );

        if (materialized.reminders.length) {
          createdReminders.push(...materialized.reminders);
          for (const reminder of materialized.reminders) {
            const [policy] = await tx
              .insert(reminderPolicies)
              .values({
                userId: params.userId,
                itemId: item.id,
                title: item.title,
                category: policyCategoryForReminder(reminder.type, item.kind),
                policyType: policyTypeForReminder(reminder.type),
                timezone: item.timezone,
                startsAt: reminder.scheduledAt,
                nextFireAt: reminder.scheduledAt,
                recurrenceRule: reminder.recurrenceKey,
                requireAck: reminder.repeatUntilAck ?? false,
                metadata: {
                  actionPlanId: planRecord.id,
                  actionPlanSequence: index,
                  reminderType: reminder.type,
                  ...inferBeforeEventReminderMetadata(
                    reminder.type,
                    reminder.scheduledAt,
                    item.timezone,
                  ),
                  ...reminderPayloadPolicyMetadata(reminder.payload),
                  basePriority: item.priority,
                  importanceMode: item.metadata.importanceMode ?? "auto",
                },
              })
              .returning();
            const [createdReminder] = await tx
              .insert(reminders)
              .values({
                userId: params.userId,
                plannerItemId: item.id,
                type: reminder.type,
                idempotencyKey: `${planRecord.id}:${index}:${reminder.type}:${reminder.scheduledAt.toISOString()}`,
                scheduledAt: reminder.scheduledAt,
                repeatUntilAck: reminder.repeatUntilAck ?? false,
                recurrenceKey: reminder.recurrenceKey,
                policyId: policy?.id,
                purpose: purposeForReminder(reminder.type),
                menuType: menuTypeForReminder(reminder.type),
                payload: reminder.payload,
              })
              .onConflictDoNothing()
              .returning();
            if (policy && createdReminder) {
              await tx.insert(reminderPolicyOccurrences).values({
                policyId: policy.id,
                reminderId: createdReminder.id,
                scheduledFor: reminder.scheduledAt,
                metadata: { actionPlanId: planRecord.id },
              });
            }
          }
        }

        await tx.insert(auditLog).values({
          userId: params.userId,
          action: "action_plan.item_created",
          entityType: "planner_item",
          entityId: item.id,
          details: { actionPlanId: planRecord.id, sequence: index, kind: item.kind },
        });
        if (item.metadata?.todayTaskDueNormalized === true) {
          await tx.insert(auditLog).values({
            userId: params.userId,
            action: "assistant.today_task_due_normalized",
            entityType: "planner_item",
            entityId: item.id,
            details: {
              actionPlanId: planRecord.id,
              dueAt: item.dueAt?.toISOString() ?? null,
              sourceNormalization: item.metadata.sourceNormalization ?? null,
            },
          });
        }
        if (item.metadata?.phraseOrderNormalization === "open_nag_until_ack_v2270") {
          await tx.insert(auditLog).values({
            userId: params.userId,
            action: "assistant.until_done_phrase_detected",
            entityType: "planner_item",
            entityId: item.id,
            details: {
              actionPlanId: planRecord.id,
              textHash: item.metadata.untilDoneTextHash ?? null,
              intervalMinutes: item.metadata.intervalMinutes ?? null,
              stopCondition: "until_done",
              titleHash: item.metadata.untilDoneTitleHash ?? null,
              titlePreviewSafe: item.metadata.untilDoneTitlePreviewSafe ?? null,
              sourceOrder: item.metadata.untilDoneSourceOrder ?? "mixed",
              timezone: item.timezone || params.timezone,
            },
          });
        }
      }

      for (const [policyIndex, proposal] of reminderPolicyProposals.entries()) {
        const targets = await resolvePolicyTargetsInTransaction({
          tx,
          proposal,
          createdItems,
          userId: params.userId,
          timezone: params.timezone,
        });
        const targetList = targets.length ? targets : [null];
        for (const target of targetList) {
          const timezone = target?.timezone || params.timezone;
          const startsAt = localDate(proposal.startsAtLocal, timezone);
          const endsAt = localDate(proposal.endsAtLocal, timezone);
          const nextFireAt = determinePolicyInitialFire({
            proposal,
            item: target,
            timezone,
            startsAt,
            now,
          });
          if (!nextFireAt || (endsAt && nextFireAt > endsAt)) {
            const rejectedGuard = !nextFireAt
              ? "missing_initial_fire"
              : "initial_fire_after_window_end";
            throw new UserFacingError(
              `Не удалось безопасно определить запуск: ${proposal.title}. ` +
                `Guard: ${rejectedGuard}; policyType=${proposal.policyType}; ` +
                `startsAt=${proposal.startsAtLocal ?? "null"}; ` +
                `nextFireAt=${proposal.nextFireAtLocal ?? "null"}; ` +
                `endsAt=${proposal.endsAtLocal ?? "null"}.`,
              "policy_initial_fire_rejected",
            );
          }
          const [policy] = await tx
            .insert(reminderPolicies)
            .values({
              userId: params.userId,
              itemId: target?.id,
              title: proposal.title || target?.title || "Напоминание",
              category: proposal.category,
              policyType: proposal.policyType,
              timezone,
              startsAt,
              endsAt,
              nextFireAt,
              recurrenceRule: proposal.recurrenceRule,
              intervalMinutes: proposal.intervalMinutes,
              requireAck: proposal.requireAck,
              maxOccurrences: proposal.maxOccurrences,
              windowEndInclusive: proposal.windowEndInclusive,
              catchUpMode: proposal.catchUpMode,
              onWindowEnd: proposal.onWindowEnd,
              quietHours:
                proposal.quietHoursStart && proposal.quietHoursEnd
                  ? {
                      start: proposal.quietHoursStart,
                      end: proposal.quietHoursEnd,
                      allowDuringQuietHours: proposal.allowDuringQuietHours,
                    }
                  : proposal.allowDuringQuietHours
                    ? { allowDuringQuietHours: true }
                    : null,
              metadata: {
                idempotencyKey: `${planRecord.id}:policy:${policyIndex}:${target?.id ?? "unattached"}`,
                actionPlanId: planRecord.id,
                policyIndex,
                basePriority: target?.priority ?? 3,
                importanceMode: target?.metadata?.importanceMode ?? "auto",
                campaignGroup: target?.metadata?.campaignGroup ?? null,
                campaignSequence: target?.metadata?.campaignSequence ?? null,
                campaignState: target?.metadata?.campaignState ?? null,
                ...inferPolicyProposalMetadata(proposal, nextFireAt, timezone, target),
                stopOnItemComplete: proposal.requireAck,
                stopCondition: proposal.requireAck ? "until_done" : null,
                recurrenceRuleVersion: proposal.recurrenceRule?.includes(":")
                  ? "canonical-v2100"
                  : "legacy",
              },
            })
            .returning();
          if (!policy) throw new UserFacingError("Не получилось создать reminder policy.");
          createdPolicies.push(policy);
          if (target?.metadata?.untilDoneAiProposalNormalized === true) {
            await tx.insert(auditLog).values({
              userId: params.userId,
              action: "assistant.until_done_ai_proposal_normalized",
              entityType: "reminder_policy",
              entityId: policy.id,
              details: {
                originalPolicyType: target.metadata.originalPolicyType ?? null,
                normalizedPolicyType: "nag_until_ack",
                reason: "source_text_contains_cadence_and_until_done",
                intervalMinutes: proposal.intervalMinutes,
                startsAtMode: "now",
                endsAt: null,
              },
            });
          }

          const spacing = await findNextAvailableReminderSlot({
            ownerId: params.userId,
            desiredAt: nextFireAt,
            latestAt: spacingLatestAtForPolicyProposal(proposal, endsAt, nextFireAt),
          });
          const [reminder] = await tx
            .insert(reminders)
            .values({
              userId: params.userId,
              plannerItemId: target?.id,
              type: reminderTypeForPolicyProposal(proposal.policyType),
              idempotencyKey: `policy:${policy.id}:${nextFireAt.toISOString()}`,
              scheduledAt: spacing.scheduledAt,
              repeatUntilAck: proposal.requireAck,
              recurrenceKey: proposal.recurrenceRule,
              policyId: policy.id,
              purpose: purposeForPolicyProposal(proposal.policyType),
              menuType: ["after_event", "post_event_menu"].includes(proposal.policyType)
                ? "event_reaction"
                : "reminder",
              payload: {
                title: policy.title,
                policyType: policy.policyType,
                category: policy.category,
                requireAck: policy.requireAck,
                scheduledFor: nextFireAt.toISOString(),
                originalDesiredAt: nextFireAt.toISOString(),
                spacingShiftMinutes: spacing.shiftMinutes,
                spacingBlockedReason: spacing.blockedReason ?? null,
              },
            })
            .onConflictDoNothing({ target: reminders.idempotencyKey })
            .returning();
          if (!reminder) throw new UserFacingError("Не получилось создать initial reminder.");
          createdPolicyReminderIds.push(reminder.id);
          await tx.insert(reminderPolicyOccurrences).values({
            policyId: policy.id,
            reminderId: reminder.id,
            scheduledFor: nextFireAt,
            metadata: {
              actionPlanId: planRecord.id,
              policyIndex,
              deliveryAt: spacing.scheduledAt.toISOString(),
            },
          });
          if (policy.metadata?.openEndedUntilDone === true) {
            await tx.insert(auditLog).values({
              userId: params.userId,
              action: "assistant.nag_until_ack_open_started",
              entityType: "reminder_policy",
              entityId: policy.id,
              details: {
                itemId: target?.id ?? null,
                policyId: policy.id,
                reminderId: reminder.id,
                intervalMinutes: proposal.intervalMinutes,
                nextFireAt: spacing.scheduledAt.toISOString(),
                endsAt: null,
                timezone,
              },
            });
          }
          if (spacing.shifted || spacing.blockedReason) {
            await tx.insert(auditLog).values({
              userId: params.userId,
              action: "assistant.reminder_spacing_applied",
              entityType: "reminder",
              entityId: reminder.id,
              details: {
                phase: "action_plan_commit",
                plannerItemId: target?.id ?? null,
                policyId: policy.id,
                originalDesiredAt: nextFireAt.toISOString(),
                scheduledAt: spacing.scheduledAt.toISOString(),
                shifted: spacing.shifted,
                shiftMinutes: spacing.shiftMinutes,
                blockedReason: spacing.blockedReason ?? null,
              },
            });
          }
        }
      }

      return {
        status: "committed" as const,
        plan: planRecord,
        items: createdItems,
        reminders: createdReminders,
        policies: createdPolicies,
        policyReminderIds: createdPolicyReminderIds,
        parsedPlan: plan,
      };
    })
    .then(async (result) => {
      if (result.status === "committed") {
        await storePlanMemoryFacts({
          userId: params.userId,
          sourceMessageId: result.plan.sourceMessageId,
          plan: result.parsedPlan,
        });
      }
      return result;
    });
}

type ActionPlanTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function resolvePolicyTargetsInTransaction(params: {
  tx: ActionPlanTransaction;
  proposal: AgentReminderPolicy;
  createdItems: Array<typeof plannerItems.$inferSelect>;
  userId: string;
  timezone: string;
}) {
  if (params.proposal.itemIds.length) {
    return params.tx
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          inArray(plannerItems.id, params.proposal.itemIds),
        ),
      );
  }
  return matchPolicyTargetsByTitle(params);
}

export function matchPolicyTargetsByTitle(params: {
  proposal: AgentReminderPolicy;
  createdItems: Array<typeof plannerItems.$inferSelect>;
  timezone: string;
}) {
  if (!params.proposal.itemTitle) return [];
  const candidates = params.createdItems.filter(
    (item) => normalizeTitle(item.title) === normalizeTitle(params.proposal.itemTitle!),
  );
  // The AI words policy titles a little differently ("…, дедлайн 23.59 сегодня" vs
  // "…, дедлайн 23.59"). With one created item there is nothing to choose between, and
  // an unattached policy only ever sends a bare "Напоминание." card.
  if (!candidates.length && params.createdItems.length === 1) return [...params.createdItems];
  if (candidates.length <= 1) return candidates;
  if (
    params.proposal.policyType === "before_event" &&
    params.proposal.minutesBefore &&
    !params.proposal.nextFireAtLocal &&
    !params.proposal.startsAtLocal
  ) {
    return candidates;
  }
  const end = localDate(params.proposal.endsAtLocal, params.timezone);
  if (!end) return [candidates[0]];
  return [
    [...candidates]
      .filter((item) => item.startAt && item.startAt > end)
      .sort((left, right) => left.startAt!.getTime() - right.startAt!.getTime())[0] ??
      candidates[0],
  ];
}

function determinePolicyInitialFire(params: {
  proposal: AgentReminderPolicy;
  item: typeof plannerItems.$inferSelect | null;
  timezone: string;
  startsAt: Date | null;
  now: Date;
}) {
  if (params.proposal.nextFireAtLocal) {
    return localIsoToUtcDate(params.proposal.nextFireAtLocal, params.timezone);
  }
  if (params.proposal.policyType === "before_event" && params.item) {
    const anchor = params.item.startAt ?? params.item.dueAt;
    return anchor
      ? DateTime.fromJSDate(anchor, { zone: "utc" })
          .minus({ minutes: params.proposal.minutesBefore ?? 60 })
          .toJSDate()
      : null;
  }
  if (params.startsAt) return params.startsAt;
  if (
    params.proposal.policyType === "nag_until_ack" &&
    params.proposal.requireAck === true &&
    params.proposal.intervalMinutes
  ) {
    return DateTime.fromJSDate(params.now, { zone: "utc" })
      .setZone(params.timezone)
      .plus({ minutes: 5 })
      .startOf("minute")
      .toUTC()
      .toJSDate();
  }
  if (["recurring", "long_term"].includes(params.proposal.policyType)) {
    const missingField = recurringRuleMissingField(params.proposal.recurrenceRule);
    if (missingField) {
      throw new UserFacingError(
        `Понял повторяющееся напоминание, но не хватает времени: ${params.proposal.title}`,
        `recurring_policy_missing_${missingField}`,
      );
    }
    const next = nextRecurringOccurrence({
      rule: params.proposal.recurrenceRule,
      after: params.now,
      timezone: params.timezone,
    });
    if (next) return next;
  }
  return null;
}

function assertReminderPoliciesAreCompleteBeforeCommit(proposals: AgentReminderPolicy[]) {
  const incomplete = proposals.find((proposal) => {
    if (!["recurring", "long_term"].includes(proposal.policyType)) return false;
    return Boolean(recurringRuleMissingField(proposal.recurrenceRule));
  });
  if (!incomplete) return;
  const missingField = recurringRuleMissingField(incomplete.recurrenceRule);
  throw new UserFacingError(
    `Понял повторяющееся напоминание, но не хватает времени: ${incomplete.title}. Напиши время, например: 09:00.`,
    `recurring_policy_missing_${missingField ?? "reminderTime"}`,
  );
}

function inferPolicyProposalMetadata(
  proposal: AgentReminderPolicy,
  nextFireAt: Date,
  timezone: string,
  target?: typeof plannerItems.$inferSelect | null,
) {
  const metadata: Record<string, unknown> = {};
  if (proposal.policyType === "before_event" && proposal.minutesBefore) {
    metadata.minutesBefore = proposal.minutesBefore;
    metadata.relativeLabel = formatBeforeEventOffset(proposal.minutesBefore, nextFireAt, timezone);
  }
  if (isTodayUntilDonePolicyProposal(proposal)) {
    const policyWindowEndLocal = localIsoWithOffset(proposal.endsAtLocal, timezone);
    metadata.sourceNormalization = "today_until_done_v2190";
    metadata.normalization = "today_until_done";
    metadata.timeScope = "today";
    metadata.untilDone = true;
    metadata.endOfDayLocal = "23:59";
    metadata.activeWindowEnd = "23:59";
    metadata.itemDueAtLocal = target?.dueAt
      ? DateTime.fromJSDate(target.dueAt, { zone: "utc" })
          .setZone(target.timezone || timezone)
          .toISO({ suppressMilliseconds: true })
      : policyWindowEndLocal;
    metadata.policyWindowEndLocal = policyWindowEndLocal;
    metadata.intervalMinutes = proposal.intervalMinutes;
    metadata.onWindowEndSemantic = "move_to_overdue_or_review";
  }
  if (
    proposal.policyType === "nag_until_ack" &&
    proposal.requireAck === true &&
    target?.metadata?.openEndedUntilDone === true
  ) {
    metadata.sourceNormalization = "open_nag_until_ack_v2240";
    if (target.metadata.phraseOrderNormalization) {
      metadata.phraseOrderNormalization = target.metadata.phraseOrderNormalization;
    }
    metadata.openEndedUntilDone = true;
    metadata.timeScope = "persistent";
    metadata.intervalMinutes = proposal.intervalMinutes;
    metadata.stopCondition = "until_done";
    metadata.firstReminderAtLocal = proposal.nextFireAtLocal ?? proposal.startsAtLocal;
    metadata.untilDoneTextHash = target.metadata.untilDoneTextHash ?? null;
    metadata.untilDoneTitleHash = target.metadata.untilDoneTitleHash ?? null;
    metadata.untilDoneSourceOrder = target.metadata.untilDoneSourceOrder ?? null;
  }
  return metadata;
}

function reminderPayloadPolicyMetadata(payload: Record<string, unknown>) {
  const metadata: Record<string, unknown> = {};
  const minutesBefore = Number(payload.minutesBefore);
  if (Number.isFinite(minutesBefore) && minutesBefore > 0) {
    metadata.minutesBefore = Math.round(minutesBefore);
  }
  if (typeof payload.relativeLabel === "string" && payload.relativeLabel.trim()) {
    metadata.relativeLabel = payload.relativeLabel.trim();
  }
  if (payload.eventMorningSet === true) {
    metadata.eventMorningSet = true;
  }
  if (typeof payload.sourceNormalization === "string") {
    metadata.sourceNormalization = payload.sourceNormalization;
  }
  return metadata;
}

function localDate(value: string | null, timezone: string) {
  return value ? localIsoToUtcDate(value, timezone) : null;
}

function isTodayUntilDonePolicyProposal(proposal: AgentReminderPolicy) {
  if (proposal.policyType !== "nag_until_ack") return false;
  if (proposal.requireAck !== true) return false;
  if (!proposal.endsAtLocal) return false;
  return (
    proposal.category === "nag_until_done" || proposal.onWindowEnd === "move_to_overdue_or_review"
  );
}

function localIsoWithOffset(value: string | null, timezone: string) {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: timezone });
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : value;
}

function spacingLatestAtForPolicyProposal(
  proposal: AgentReminderPolicy,
  endsAt: Date | null,
  nextFireAt: Date,
) {
  if (endsAt && ["interval_window", "nag_until_ack"].includes(proposal.policyType)) return endsAt;
  if (proposal.policyType !== "before_event") return null;
  const minutesBefore = proposal.minutesBefore ?? 0;
  if (!minutesBefore) return nextFireAt;
  return new Date(nextFireAt.getTime() + Math.max(1, minutesBefore - 1) * 60_000);
}

function reminderTypeForPolicyProposal(policyType: string) {
  if (policyType === "before_event") return "event_before";
  if (["after_event", "post_event_menu"].includes(policyType)) return "after_event";
  if (["recurring", "long_term"].includes(policyType)) return "recurring";
  if (policyType === "nag_until_ack") return "until_ack";
  return "custom";
}

function purposeForPolicyProposal(policyType: string) {
  if (policyType === "before_event") return "pre_event";
  if (["after_event", "post_event_menu"].includes(policyType)) return "post_event_menu";
  if (policyType === "interval_window") return "interval_nag";
  if (["recurring", "long_term"].includes(policyType)) return "recurring_check";
  return "reminder";
}

function normalizeTitle(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function assertPlanDoesNotContainManagementCommands(plan: ActionPlan) {
  const blocked = plan.actions.find(
    (action) =>
      isHardManagementText(action.title) ||
      (action.description ? isHardManagementText(action.description) : false),
  );
  if (blocked) {
    throw new UserFacingError(
      "Понял, это команда управления, а не новая задача. Ничего не создаю.",
    );
  }
}

export async function cancelStoredActionPlan(params: { actionPlanId: string; userId: string }) {
  const [cancelled] = await getDb()
    .update(actionPlans)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(actionPlans.id, params.actionPlanId),
        eq(actionPlans.userId, params.userId),
        eq(actionPlans.status, "pending"),
      ),
    )
    .returning();
  return cancelled ?? null;
}

async function findActionPlanByIdempotencyKey(idempotencyKey: string) {
  const [existing] = await getDb()
    .select()
    .from(actionPlans)
    .where(eq(actionPlans.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing ?? null;
}

export function materializeAction(params: {
  action: ActionPlanItem;
  timezone: string;
  now: Date;
  actionPlanId: string;
  sequence: number;
}): { item: MaterializedItem; reminders: MaterializedReminder[] } {
  const timezone = params.action.timezone || params.timezone;
  const startAt = params.action.startAtLocal
    ? localIsoToUtcDate(params.action.startAtLocal, timezone)
    : null;
  const dueAt = params.action.dueAtLocal
    ? localIsoToUtcDate(params.action.dueAtLocal, timezone)
    : null;
  const endAt = buildEndAt(params.action, timezone, startAt);
  const sanitizedTitle = sanitizePlannerTitle(params.action.title);
  const item: MaterializedItem = {
    kind: params.action.kind,
    title: sanitizedTitle,
    description: params.action.description,
    location: params.action.location,
    timezone,
    startAt,
    endAt,
    dueAt,
    priority: params.action.priority,
    metadata: {
      actionPlanId: params.actionPlanId,
      actionPlanSequence: params.sequence,
      actionType: params.action.actionType,
      sourceTimezone: timezone,
      confidence: params.action.confidence,
      risk: params.action.risk,
      tentative: params.action.tentative,
      recurrence: params.action.recurrence,
      ...params.action.metadata,
    },
  };

  const reminders: MaterializedReminder[] = [];
  for (const reminder of params.action.reminders) {
    if (!reminder.scheduledAtLocal) continue;
    const scheduledAt = localIsoToUtcDate(reminder.scheduledAtLocal, timezone);
    if (scheduledAt.getTime() <= params.now.getTime()) continue;
    reminders.push({
      type: reminder.type,
      scheduledAt,
      repeatUntilAck: reminder.repeatUntilAck || params.action.recurrence?.repeatUntilAck || false,
      recurrenceKey: params.action.recurrence
        ? `${params.action.recurrence.frequency}:${params.action.recurrence.daysOfWeek.join(",")}:${params.action.recurrence.timeLocal}`
        : null,
      payload: {
        ...reminder.payload,
        title: sanitizedTitle,
        kind: params.action.kind,
        actionType: params.action.actionType,
        recurrence: params.action.recurrence,
      },
    });
  }

  return { item, reminders };
}

function buildEndAt(action: ActionPlanItem, timezone: string, startAt: Date | null) {
  if (action.endAtLocal) return localIsoToUtcDate(action.endAtLocal, timezone);
  if (!startAt || !action.durationMinutes) return null;
  return DateTime.fromJSDate(startAt, { zone: "utc" })
    .plus({ minutes: action.durationMinutes })
    .toJSDate();
}

function policyTypeForReminder(type: string) {
  if (["event_before", "1h", "30m", "15m", "24h", "day_morning"].includes(type)) {
    return "before_event";
  }
  if (["followup", "training_followup", "after_event"].includes(type)) {
    return "post_event_menu";
  }
  if (type === "recurring") return "recurring";
  if (type === "until_ack") return "nag_until_ack";
  return "one_time";
}

function policyCategoryForReminder(type: string, kind: string) {
  if (["followup", "training_followup", "after_event"].includes(type)) return "post_event";
  if (["event_before", "1h", "30m", "15m", "24h", "day_morning"].includes(type)) {
    return "pre_event";
  }
  if (kind === "training") return "training";
  if (type === "recurring") return "long_term";
  return "task_deadline";
}

function inferBeforeEventReminderMetadata(type: string, scheduledAt: Date, timezone: string) {
  const minutesBefore =
    {
      "10m": 10,
      "30m": 30,
      "1h": 60,
      "2h": 120,
      "24h": 1440,
      day_morning: 1440,
      event_before: null,
    }[type] ?? null;
  if (!minutesBefore) return {};
  const relativeLabel =
    type === "day_morning"
      ? `за день в ${DateTime.fromJSDate(scheduledAt, { zone: "utc" }).setZone(timezone).toFormat("HH:mm")}`
      : undefined;
  return {
    minutesBefore,
    ...(relativeLabel ? { relativeLabel } : {}),
  };
}

function purposeForReminder(type: string) {
  if (["followup", "training_followup", "after_event"].includes(type)) return "post_event_menu";
  if (["event_before", "1h", "30m", "15m", "24h", "day_morning"].includes(type)) {
    return "pre_event";
  }
  if (type === "recurring") return "recurring_check";
  return "reminder";
}

function menuTypeForReminder(type: string) {
  return ["followup", "training_followup", "after_event"].includes(type)
    ? "event_reaction"
    : "reminder";
}

function categoryForItem(kind: string) {
  if (kind === "training") return "training";
  if (kind === "event" || kind === "tentative_event") return "event";
  if (kind === "preparation_task") return "project";
  if (kind === "recurring_task") return "long_term";
  return "today_focus";
}
