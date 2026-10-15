import { DateTime } from "luxon";

import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import {
  attachOccurrenceReminder,
  createPolicyOccurrence,
  createReminderPolicyIfMissing,
  getPolicyForReminder,
  markPolicyOccurrenceAcked,
  markPolicyOccurrenceDelivered,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { createReminderIfMissing, restoreReminderByIdempotencyKey } from "@/db/queries/reminders";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import {
  applyQuietHours,
  computeNextPolicySlotAfterDelivery,
} from "@/domain/reminderPolicySchedule";
import { getUserById } from "@/db/queries/users";
import {
  nextRecurringOccurrence,
  recurringRuleMissingField,
} from "@/domain/recurringPolicySemantics";
import { UserFacingError } from "@/lib/errors";

export async function applyAgentReminderPolicies(params: {
  userId: string;
  timezone: string;
  proposals: AgentReminderPolicy[];
  availableItems: PlannerItem[];
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const byId = new Map(params.availableItems.map((item) => [item.id, item]));
  const createdPolicies: ReminderPolicy[] = [];
  const reminderIds: string[] = [];
  const warnings: string[] = [];

  for (const proposal of params.proposals) {
    const targets = resolveTargets(proposal, params.availableItems, byId);
    if (!targets.length && (proposal.itemIds.length || proposal.itemTitle)) {
      warnings.push(`policy_targets_not_found:${proposal.title}`);
      continue;
    }
    const targetList = targets.length ? targets : [null];
    for (const target of targetList) {
      const timezone = target?.timezone || params.timezone;
      const startsAt = localDate(proposal.startsAtLocal, timezone);
      const endsAt = localDate(proposal.endsAtLocal, timezone);
      const nextFireAt = determineInitialFire({
        proposal,
        item: target,
        timezone,
        startsAt,
        now,
      });
      if (!nextFireAt || nextFireAt <= now) {
        warnings.push(`policy_has_no_future_fire:${proposal.title}`);
        continue;
      }
      const policy = await createReminderPolicyIfMissing({
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
        idempotencyKey: policyKey(proposal, target, nextFireAt),
        metadata: {
          operation: proposal.operation,
          minutesBefore: proposal.minutesBefore,
          ...inferPolicyProposalMetadata(proposal, target, timezone),
          stopOnItemComplete: proposal.requireAck,
          stopCondition: proposal.requireAck ? "until_done" : null,
          recurrenceRuleVersion: proposal.recurrenceRule?.includes(":")
            ? "canonical-v2100"
            : "legacy",
          allowDuringQuietHours: proposal.allowDuringQuietHours,
          basePriority: target?.priority ?? 3,
          campaignGroup: target?.metadata?.campaignGroup ?? null,
          campaignSequence: target?.metadata?.campaignSequence ?? null,
          campaignState: target?.metadata?.campaignState ?? null,
        },
      });
      createdPolicies.push(policy);
      const reminder = await materializeNextPolicyReminder(policy, nextFireAt, { now });
      if (reminder) reminderIds.push(reminder.id);
    }
  }

  return {
    policies: [...new Map(createdPolicies.map((policy) => [policy.id, policy])).values()],
    reminderIds: [...new Set(reminderIds)],
    warnings: [...new Set(warnings)],
  };
}

export async function materializeNextPolicyReminder(
  policy: ReminderPolicy,
  fireAt?: Date | null,
  options?: { now?: Date; deliveryAt?: Date; catchUp?: boolean },
) {
  const now = options?.now ?? new Date();
  if (policy.snoozedUntil && policy.snoozedUntil > now) return null;
  const scheduledAt = fireAt ?? policy.nextFireAt;
  if (!scheduledAt) return null;
  if (
    policy.endsAt &&
    (policy.windowEndInclusive !== false
      ? scheduledAt > policy.endsAt
      : scheduledAt >= policy.endsAt)
  ) {
    return null;
  }
  const deliveryAt = await resolveDeliveryAt(policy, options?.deliveryAt ?? scheduledAt);
  if (deliveryAt < now && !options?.catchUp) return null;
  await createPolicyOccurrence({
    policyId: policy.id,
    scheduledFor: scheduledAt,
    metadata: {
      policyType: policy.policyType,
      catchUp: options?.catchUp === true,
      deliveryAt: deliveryAt.toISOString(),
    },
  });
  const idempotencyKey = `policy:${policy.id}:${scheduledAt.toISOString()}`;
  const created = await createReminderIfMissing({
    userId: policy.userId,
    plannerItemId: policy.itemId,
    type: reminderTypeForPolicy(policy),
    idempotencyKey,
    scheduledAt: deliveryAt,
    spacingLatestAt: latestSpacingAtForPolicy(policy, scheduledAt),
    repeatUntilAck: policy.requireAck,
    recurrenceKey: policy.recurrenceRule,
    policyId: policy.id,
    purpose: purposeForPolicy(policy),
    menuType: menuTypeForPolicy(policy),
    payload: {
      title: policy.title,
      policyType: policy.policyType,
      category: policy.category,
      requireAck: policy.requireAck,
      scheduledFor: scheduledAt.toISOString(),
      catchUp: options?.catchUp === true,
    },
  });
  const reminder =
    created ??
    (await restoreReminderByIdempotencyKey({
      userId: policy.userId,
      idempotencyKey,
      scheduledAt: deliveryAt,
    }));
  if (reminder) {
    await attachOccurrenceReminder({
      policyId: policy.id,
      scheduledFor: scheduledAt,
      reminderId: reminder.id,
    });
  }
  return reminder;
}

function latestSpacingAtForPolicy(policy: ReminderPolicy, deliveryAt: Date) {
  if (["interval_window", "nag_until_ack"].includes(policy.policyType) && policy.endsAt) {
    return policy.endsAt;
  }
  if (policy.policyType !== "before_event") return null;
  const minutesBefore =
    typeof policy.metadata?.minutesBefore === "number"
      ? policy.metadata.minutesBefore
      : Number(policy.metadata?.minutesBefore ?? 0);
  if (!Number.isFinite(minutesBefore) || minutesBefore <= 0) return deliveryAt;
  return new Date(deliveryAt.getTime() + Math.max(1, minutesBefore - 1) * 60_000);
}

function inferPolicyProposalMetadata(
  proposal: AgentReminderPolicy,
  target: PlannerItem | null,
  timezone: string,
) {
  if (
    proposal.policyType !== "nag_until_ack" ||
    proposal.requireAck !== true ||
    !proposal.endsAtLocal ||
    (proposal.category !== "nag_until_done" && proposal.onWindowEnd !== "move_to_overdue_or_review")
  ) {
    return {};
  }
  const policyWindowEndLocal = localIsoWithOffset(proposal.endsAtLocal, timezone);
  return {
    sourceNormalization: "today_until_done_v2190",
    normalization: "today_until_done",
    timeScope: "today",
    untilDone: true,
    endOfDayLocal: "23:59",
    activeWindowEnd: "23:59",
    itemDueAtLocal: target?.dueAt
      ? DateTime.fromJSDate(target.dueAt, { zone: "utc" })
          .setZone(target.timezone || timezone)
          .toISO({ suppressMilliseconds: true })
      : policyWindowEndLocal,
    policyWindowEndLocal,
    intervalMinutes: proposal.intervalMinutes,
    onWindowEndSemantic: "move_to_overdue_or_review",
  };
}

function localIsoWithOffset(value: string, timezone: string) {
  const parsed = DateTime.fromISO(value, { zone: timezone });
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : value;
}

export async function advancePolicyAfterDelivery(reminderId: string, deliveredAt = new Date()) {
  const row = await getPolicyForReminder(reminderId);
  if (!row) return null;
  await markPolicyOccurrenceDelivered(reminderId, deliveredAt);
  const policy = row.policy;
  if (row.reminder.purpose === "snooze") return policy;
  // An already queued reminder can be delivered after the user acknowledged the policy;
  // scheduling the next slot here revived completed policies forever.
  if (policy.status !== "active") return null;
  const scheduledFor =
    row.occurrence?.scheduledFor ?? row.reminder.scheduledAt ?? policy.nextFireAt ?? deliveredAt;
  const next = computeNextPolicySlotAfterDelivery({
    policy,
    scheduledFor,
    now: deliveredAt,
  });
  if (!next) {
    await updateReminderPolicy({
      policyId: policy.id,
      userId: policy.userId,
      status: finalStatusAfterDelivery(policy),
      nextFireAt: null,
    });
    return null;
  }
  const updated = await updateReminderPolicy({
    policyId: policy.id,
    userId: policy.userId,
    nextFireAt: next,
  });
  return updated ? materializeNextPolicyReminder(updated, next, { now: deliveredAt }) : null;
}

export async function acknowledgePolicyReminder(reminderId: string, skipped = false) {
  const row = await getPolicyForReminder(reminderId);
  if (!row) return null;
  await markPolicyOccurrenceAcked(reminderId, skipped);
  if (["interval_window", "nag_until_ack", "one_time"].includes(row.policy.policyType)) {
    return updateReminderPolicy({
      policyId: row.policy.id,
      userId: row.policy.userId,
      status: skipped ? "paused" : "completed",
      nextFireAt: null,
    });
  }
  return row.policy;
}

function resolveTargets(
  proposal: AgentReminderPolicy,
  items: PlannerItem[],
  byId: Map<string, PlannerItem>,
) {
  const direct = proposal.itemIds
    .map((id) => byId.get(id))
    .filter((item): item is PlannerItem => Boolean(item));
  if (direct.length) return direct;
  if (!proposal.itemTitle) return [];
  const normalized = normalize(proposal.itemTitle);
  return items.filter((item) => normalize(item.title) === normalized);
}

function determineInitialFire(params: {
  proposal: AgentReminderPolicy;
  item: PlannerItem | null;
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
  if (["after_event", "post_event_menu"].includes(params.proposal.policyType) && params.item) {
    return params.item.endAt ?? params.item.startAt ?? params.item.dueAt;
  }
  if (params.startsAt) return params.startsAt;
  if (["recurring", "long_term"].includes(params.proposal.policyType)) {
    const missingField = recurringRuleMissingField(params.proposal.recurrenceRule);
    if (missingField) {
      throw new UserFacingError(
        `Понял повторяющееся напоминание, но не хватает времени: ${params.proposal.title}`,
        `recurring_policy_missing_${missingField}`,
      );
    }
  }
  const canonical = nextRecurringOccurrence({
    rule: params.proposal.recurrenceRule,
    after: params.now,
    timezone: params.timezone,
  });
  if (canonical) return canonical;
  return nextFromRule(params.proposal.recurrenceRule, params.now, params.timezone);
}

function nextFromRule(rule: string | null, after: Date, timezone: string) {
  const local = DateTime.fromJSDate(after, { zone: "utc" }).setZone(timezone);
  if (!rule)
    return local
      .plus({ days: 1 })
      .startOf("day")
      .plus({ hours: 9, minutes: 30 })
      .toUTC()
      .toJSDate();
  const normalized = rule.toLowerCase();
  if (/every[_ ]?2[_ ]?weeks|biweekly|2 weeks/.test(normalized)) {
    return local.plus({ weeks: 2 }).toUTC().toJSDate();
  }
  if (/weekly|week/.test(normalized)) return local.plus({ weeks: 1 }).toUTC().toJSDate();
  if (/monthly|month/.test(normalized)) return local.plus({ months: 1 }).toUTC().toJSDate();
  if (/daily|day/.test(normalized)) return local.plus({ days: 1 }).toUTC().toJSDate();
  return local.plus({ days: 1 }).toUTC().toJSDate();
}

async function resolveDeliveryAt(policy: ReminderPolicy, scheduledAt: Date) {
  const user = await getUserById(policy.userId).catch(() => null);
  const quiet = policy.quietHours ?? {};
  return applyQuietHours({
    scheduledAt,
    timezone: policy.timezone,
    start: String(quiet.start ?? user?.quietHoursStart ?? "00:00"),
    end: String(quiet.end ?? user?.quietHoursEnd ?? "07:30"),
    allowDuringQuietHours:
      quiet.allowDuringQuietHours === true || policy.metadata?.allowDuringQuietHours === true,
  });
}

function finalStatusAfterDelivery(policy: ReminderPolicy) {
  if (["interval_window", "nag_until_ack"].includes(policy.policyType)) {
    return policy.onWindowEnd === "carry_to_next_day" ? "active" : "expired";
  }
  return policy.requireAck ? "active" : "completed";
}

function reminderTypeForPolicy(policy: ReminderPolicy) {
  if (policy.policyType === "before_event") return "event_before";
  if (["after_event", "post_event_menu"].includes(policy.policyType)) return "after_event";
  if (policy.policyType === "recurring" || policy.policyType === "long_term") return "recurring";
  if (policy.policyType === "nag_until_ack") return "until_ack";
  return "custom";
}

function purposeForPolicy(policy: ReminderPolicy) {
  if (policy.policyType === "before_event") return "pre_event";
  if (["after_event", "post_event_menu"].includes(policy.policyType)) return "post_event_menu";
  if (policy.policyType === "interval_window") return "interval_nag";
  if (policy.policyType === "recurring" || policy.policyType === "long_term")
    return "recurring_check";
  return "reminder";
}

function menuTypeForPolicy(policy: ReminderPolicy) {
  return ["after_event", "post_event_menu"].includes(policy.policyType)
    ? "event_reaction"
    : "reminder";
}

function policyKey(proposal: AgentReminderPolicy, item: PlannerItem | null, fireAt: Date) {
  return [
    proposal.operation,
    item?.id ?? "unattached",
    normalize(proposal.title),
    proposal.policyType,
    fireAt.toISOString(),
  ].join(":");
}

function localDate(value: string | null, timezone: string) {
  return value ? localIsoToUtcDate(value, timezone) : null;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
