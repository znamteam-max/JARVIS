import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const assistantSchema = pgSchema("assistant");
const assistantTable = assistantSchema.table;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

const emptyJson = sql`'{}'::jsonb`;
const emptyArrayJson = sql`'[]'::jsonb`;

export const users = assistantTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    telegramUsername: text("telegram_username"),
    firstName: text("first_name"),
    timezone: text("timezone").notNull().default("Europe/Helsinki"),
    locale: text("locale").notNull().default("ru"),
    smartCommitMode: text("smart_commit_mode").notNull().default("auto_low_risk"),
    isOnboarded: boolean("is_onboarded").notNull().default(false),
    quietHoursStart: text("quiet_hours_start").notNull().default("00:00"),
    quietHoursEnd: text("quiet_hours_end").notNull().default("07:30"),
    // owner = the planner's owner (main bot, app); athlete = only the coach bot.
    role: text("role").notNull().default("owner"),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_telegram_user_id_uq").on(table.telegramUserId)],
);

// A person using the separate coach bot: asked → approved by the owner in the main bot;
// their own Intervals.icu key (encrypted) feeds their workouts and recovery.
export const athleteConnections = assistantTable(
  "athlete_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // pending | approved | denied
    status: text("status").notNull().default("pending"),
    telegramUsername: text("telegram_username"),
    firstName: text("first_name"),
    intervalsAthleteId: text("intervals_athlete_id"),
    intervalsApiKey: text("intervals_api_key"),
    ...timestamps,
  },
  (table) => [uniqueIndex("athlete_connections_telegram_user_uq").on(table.telegramUserId)],
);

export const telegramMessages = assistantTable(
  "telegram_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    updateId: bigint("update_id", { mode: "bigint" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }),
    chatId: bigint("chat_id", { mode: "bigint" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    messageType: text("message_type").notNull().default("unknown"),
    text: text("text"),
    transcript: text("transcript"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(emptyJson),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_messages_update_id_uq").on(table.updateId),
    index("telegram_messages_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const conversationMessages = assistantTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    telegramMessageId: uuid("telegram_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
    messageType: text("message_type").notNull().default("text"),
    text: text("text"),
    transcript: text("transcript"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_messages_user_created_idx").on(table.userId, table.createdAt),
    index("conversation_messages_role_idx").on(table.role),
  ],
);

export const messageAttachments = assistantTable("message_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").references(() => telegramMessages.id, { onDelete: "cascade" }),
  telegramFileId: text("telegram_file_id").notNull(),
  telegramFileUniqueId: text("telegram_file_unique_id"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  durationSeconds: integer("duration_seconds"),
  status: text("status").notNull().default("processed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actionPlans = assistantTable(
  "action_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    summary: text("summary"),
    commitMode: text("commit_mode").notNull().default("auto_low_risk"),
    confidencePercent: integer("confidence_percent").notNull().default(50),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_plans_idempotency_uq").on(table.idempotencyKey),
    index("action_plans_user_status_idx").on(table.userId, table.status),
    index("action_plans_source_message_idx").on(table.sourceMessageId),
  ],
);

export const actionPlanItems = assistantTable(
  "action_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionPlanId: uuid("action_plan_id")
      .notNull()
      .references(() => actionPlans.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    committedItemId: uuid("committed_item_id").references(() => plannerItems.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_plan_items_plan_sequence_uq").on(table.actionPlanId, table.sequence),
    index("action_plan_items_user_status_idx").on(table.userId, table.status),
  ],
);

export const pendingActions = assistantTable(
  "pending_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pending_actions_idempotency_uq").on(table.idempotencyKey),
    index("pending_actions_user_status_idx").on(table.userId, table.status),
  ],
);

export const plannerItems = assistantTable(
  "planner_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pendingActionId: uuid("pending_action_id").references(() => pendingActions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    timezone: text("timezone").notNull().default("Europe/Helsinki"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    category: text("category"),
    visibility: text("visibility").default("active"),
    sourcePolicyId: uuid("source_policy_id"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    priority: integer("priority").notNull().default(3),
    source: text("source").notNull().default("telegram"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("planner_items_pending_action_uq").on(table.pendingActionId),
    index("planner_items_user_start_idx").on(table.userId, table.startAt),
    index("planner_items_user_due_idx").on(table.userId, table.dueAt),
    index("planner_items_user_status_idx").on(table.userId, table.status),
  ],
);

export const taskViewStates = assistantTable(
  "task_view_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("current"),
    title: text("title").notNull(),
    itemIds: jsonb("item_ids").$type<string[]>().notNull().default(emptyArrayJson),
    itemsSnapshot: jsonb("items_snapshot")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(emptyArrayJson),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("task_view_states_user_created_idx").on(table.userId, table.createdAt),
    index("task_view_states_user_scope_idx").on(table.userId, table.scope),
  ],
);

export const itemSyncState = assistantTable(
  "item_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plannerItemId: uuid("planner_item_id")
      .notNull()
      .references(() => plannerItems.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("google_calendar"),
    externalId: text("external_id"),
    status: text("status").notNull().default("not_synced"),
    lastError: text("last_error"),
    durationMs: integer("duration_ms"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("item_sync_state_item_provider_uq").on(table.plannerItemId, table.provider),
  ],
);

export const externalCalendarEvents = assistantTable(
  "external_calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("yandex"),
    calendarLabel: text("calendar_label").notNull().default("Личный"),
    calendarObjectUrl: text("calendar_object_url").notNull(),
    uid: text("uid").notNull(),
    etag: text("etag"),
    summary: text("summary").notNull(),
    description: text("description"),
    location: text("location"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    timezone: text("timezone").notNull().default("Europe/Moscow"),
    isRecurring: boolean("is_recurring").notNull().default(false),
    recurrenceRule: text("recurrence_rule"),
    recurrenceId: text("recurrence_id").notNull().default(""),
    exdates: jsonb("exdates").$type<string[]>().notNull().default(emptyArrayJson),
    source: text("source").notNull().default("yandex_external"),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("external_calendar_events_user_object_recurrence_uq").on(
      table.userId,
      table.calendarObjectUrl,
      table.recurrenceId,
    ),
    index("external_calendar_events_user_start_idx").on(table.userId, table.startAt),
    index("external_calendar_events_user_uid_idx").on(table.userId, table.uid),
  ],
);

export const calendarImportState = assistantTable("calendar_import_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("yandex"),
  lastImportAt: timestamp("last_import_at", { withTimezone: true }),
  importedEventsCount: integer("imported_events_count").notNull().default(0),
  recurringEventsCount: integer("recurring_events_count").notNull().default(0),
  externalEventsVisible: integer("external_events_visible").notNull().default(0),
  possibleDuplicates: integer("possible_duplicates").notNull().default(0),
  lastImportErrorClass: text("last_import_error_class"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
  ...timestamps,
});

export const reminders = assistantTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plannerItemId: uuid("planner_item_id").references(() => plannerItems.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    repeatUntilAck: boolean("repeat_until_ack").notNull().default(false),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    parentReminderId: uuid("parent_reminder_id"),
    recurrenceKey: text("recurrence_key"),
    policyId: uuid("policy_id"),
    purpose: text("purpose"),
    menuType: text("menu_type"),
    autoDeleteAfterResponse: boolean("auto_delete_after_response").notNull().default(true),
    supersededByMessageId: bigint("superseded_by_message_id", { mode: "bigint" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("reminders_item_type_time_uq").on(
      table.plannerItemId,
      table.type,
      table.scheduledAt,
    ),
    uniqueIndex("reminders_idempotency_key_uq").on(table.idempotencyKey),
    index("reminders_due_idx").on(table.status, table.scheduledAt),
    index("reminders_user_idx").on(table.userId),
    index("reminders_ack_idx").on(table.userId, table.repeatUntilAck, table.ackedAt),
    index("reminders_policy_idx").on(table.policyId),
  ],
);

export const reminderPolicies = assistantTable(
  "reminder_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => plannerItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    category: text("category").notNull(),
    policyType: text("policy_type").notNull(),
    status: text("status").notNull().default("active"),
    timezone: text("timezone").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    recurrenceRule: text("recurrence_rule"),
    intervalMinutes: integer("interval_minutes"),
    requireAck: boolean("require_ack").notNull().default(false),
    maxOccurrences: integer("max_occurrences"),
    windowEndInclusive: boolean("window_end_inclusive").notNull().default(true),
    catchUpMode: text("catch_up_mode").notNull().default("one_immediate_then_resume"),
    onWindowEnd: text("on_window_end").notNull().default("expire_silently"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozeScope: text("snooze_scope"),
    quietHours: jsonb("quiet_hours").$type<Record<string, unknown> | null>(),
    escalationPolicy: jsonb("escalation_policy").$type<Record<string, unknown> | null>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("reminder_policies_user_status_idx").on(table.userId, table.status),
    index("reminder_policies_next_fire_idx").on(table.status, table.nextFireAt),
    index("reminder_policies_item_idx").on(table.itemId),
  ],
);

export const reminderPolicyOccurrences = assistantTable(
  "reminder_policy_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => reminderPolicies.id, { onDelete: "cascade" }),
    reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "set null" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    status: text("status").notNull().default("scheduled"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
  },
  (table) => [
    uniqueIndex("reminder_policy_occurrences_policy_time_uq").on(
      table.policyId,
      table.scheduledFor,
    ),
    index("reminder_policy_occurrences_status_idx").on(table.status, table.scheduledFor),
  ],
);

export const schedulerRuntimeHealth = assistantTable("scheduler_runtime_health", {
  key: text("key").primaryKey(),
  lastRunnerStartedAt: timestamp("last_runner_started_at", { withTimezone: true }),
  lastRunnerFinishedAt: timestamp("last_runner_finished_at", { withTimezone: true }),
  lastRunnerClaimed: integer("last_runner_claimed").notNull().default(0),
  lastRunnerSent: integer("last_runner_sent").notNull().default(0),
  lastRunnerFailed: integer("last_runner_failed").notNull().default(0),
  lastPolicyReconcileAt: timestamp("last_policy_reconcile_at", { withTimezone: true }),
  lastPolicyReconcileChecked: integer("last_policy_reconcile_checked").notNull().default(0),
  lastPolicyReconcileCreated: integer("last_policy_reconcile_created").notNull().default(0),
  lastSchedulerHitAt: timestamp("last_scheduler_hit_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runtimeLocks = assistantTable(
  "runtime_locks",
  {
    key: text("key").primaryKey(),
    ownerToken: text("owner_token").notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("runtime_locks_expiry_idx").on(table.lockedUntil)],
);

export const liveDashboards = assistantTable(
  "live_dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    dashboardType: text("dashboard_type").notNull().default("main"),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("live_dashboards_user_chat_status_idx").on(table.userId, table.chatId, table.status),
    index("live_dashboards_created_idx").on(table.createdAt),
  ],
);

export const telegramMessageRegistry = assistantTable(
  "telegram_message_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    purpose: text("purpose").notNull(),
    relatedItemId: uuid("related_item_id").references(() => plannerItems.id, {
      onDelete: "set null",
    }),
    relatedReminderId: uuid("related_reminder_id").references(() => reminders.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("telegram_message_registry_chat_message_uq").on(table.chatId, table.messageId),
    index("telegram_message_registry_item_idx").on(table.relatedItemId, table.status),
    index("telegram_message_registry_purpose_idx").on(table.chatId, table.purpose, table.status),
  ],
);

export const reminderDeliveries = assistantTable(
  "reminder_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reminder_deliveries_reminder_idx").on(table.reminderId),
    index("reminder_deliveries_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const memories = assistantTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("active"),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    searchTags: jsonb("search_tags").$type<string[]>().notNull().default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [index("memories_user_status_idx").on(table.userId, table.status)],
);

export const memoryFacts = assistantTable(
  "memory_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("project"),
    content: text("content").notNull(),
    source: text("source").notNull().default("planner"),
    status: text("status").notNull().default("active"),
    confidencePercent: integer("confidence_percent").notNull().default(70),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    embedding: jsonb("embedding").$type<number[] | null>(),
    searchTags: jsonb("search_tags").$type<string[]>().notNull().default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [
    index("memory_facts_user_status_idx").on(table.userId, table.status),
    index("memory_facts_category_idx").on(table.category),
  ],
);

export const conversationSummaries = assistantTable(
  "conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    summary: text("summary").notNull(),
    sourceMessageIds: jsonb("source_message_ids")
      .$type<string[]>()
      .notNull()
      .default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [index("conversation_summaries_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const googleCalendarConnections = assistantTable(
  "google_calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    googleEmail: text("google_email"),
    calendarId: text("calendar_id").notNull().default("primary"),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("connected"),
    ...timestamps,
  },
  (table) => [uniqueIndex("google_calendar_connections_user_uq").on(table.userId)],
);

export const calendarSyncJobs = assistantTable(
  "calendar_sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plannerItemId: uuid("planner_item_id").references(() => plannerItems.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("calendar_sync_jobs_item_provider_uq").on(table.plannerItemId, table.provider),
    index("calendar_sync_jobs_status_idx").on(table.status, table.nextAttemptAt),
    index("calendar_sync_jobs_item_idx").on(table.plannerItemId),
  ],
);

export const auditLog = assistantTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_user_created_idx").on(table.userId, table.createdAt)],
);

export const agentActions = assistantTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("completed"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default(emptyJson),
    output: jsonb("output").$type<Record<string, unknown>>().notNull().default(emptyJson),
    undoPayload: jsonb("undo_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_actions_user_created_idx").on(table.userId, table.createdAt),
    index("agent_actions_source_message_idx").on(table.sourceMessageId),
  ],
);

export const releaseNotifications = assistantTable(
  "release_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(),
    commitSha: text("commit_sha").notNull(),
    environment: text("environment").notNull().default("production"),
    status: text("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default(emptyJson),
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("release_notifications_version_commit_environment_uq").on(
      table.version,
      table.commitSha,
      table.environment,
    ),
    index("release_notifications_status_created_idx").on(table.status, table.createdAt),
    index("release_notifications_version_sent_idx").on(table.version, table.sentAt),
  ],
);

export const foodEntries = assistantTable(
  "food_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    telegramFileId: text("telegram_file_id"),
    // Compressed copy in Cloudflare R2 (jarvis-media worker); status stored|deleted|failed.
    photoKey: text("photo_key"),
    photoStatus: text("photo_status"),
    caption: text("caption"),
    title: text("title").notNull(),
    eatenAt: timestamp("eaten_at", { withTimezone: true }).notNull(),
    calories: integer("calories").notNull(),
    proteinG: integer("protein_g").notNull(),
    fatG: integer("fat_g").notNull(),
    carbsG: integer("carbs_g").notNull(),
    items: jsonb("items")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    confidence: text("confidence").notNull(),
    model: text("model"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [index("food_entries_user_eaten_idx").on(table.userId, table.eatenAt)],
);

export const stravaConnections = assistantTable(
  "strava_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    athleteId: bigint("athlete_id", { mode: "bigint" }).notNull(),
    athleteName: text("athlete_name"),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scope: text("scope"),
    status: text("status").notNull().default("active"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    ...timestamps,
  },
  (table) => [uniqueIndex("strava_connections_user_idx").on(table.userId)],
);

export const stravaActivities = assistantTable(
  "strava_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stravaId: bigint("strava_id", { mode: "bigint" }).notNull(),
    name: text("name").notNull(),
    sportType: text("sport_type").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    timezone: text("timezone"),
    distanceM: integer("distance_m").notNull().default(0),
    movingTimeS: integer("moving_time_s").notNull().default(0),
    elapsedTimeS: integer("elapsed_time_s").notNull().default(0),
    elevationGainM: integer("elevation_gain_m").notNull().default(0),
    averageHeartrate: integer("average_heartrate"),
    maxHeartrate: integer("max_heartrate"),
    calories: integer("calories"),
    sufferScore: integer("suffer_score"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(emptyJson),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("strava_activities_strava_id_idx").on(table.stravaId),
    index("strava_activities_user_start_idx").on(table.userId, table.startAt),
  ],
);

export type User = typeof users.$inferSelect;
export type AthleteConnection = typeof athleteConnections.$inferSelect;
export type PlannerItem = typeof plannerItems.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type ReminderPolicy = typeof reminderPolicies.$inferSelect;
export type ReminderPolicyOccurrence = typeof reminderPolicyOccurrences.$inferSelect;
export type SchedulerRuntimeHealth = typeof schedulerRuntimeHealth.$inferSelect;
export type LiveDashboard = typeof liveDashboards.$inferSelect;
export type TelegramMessageRegistryEntry = typeof telegramMessageRegistry.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type MemoryFact = typeof memoryFacts.$inferSelect;
export type ActionPlanRecord = typeof actionPlans.$inferSelect;
export type ActionPlanItemRecord = typeof actionPlanItems.$inferSelect;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type ReminderDelivery = typeof reminderDeliveries.$inferSelect;
export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect;
export type CalendarSyncJob = typeof calendarSyncJobs.$inferSelect;
export type TaskViewState = typeof taskViewStates.$inferSelect;
export type AgentAction = typeof agentActions.$inferSelect;
export type ExternalCalendarEvent = typeof externalCalendarEvents.$inferSelect;
export type CalendarImportState = typeof calendarImportState.$inferSelect;
export type ReleaseNotification = typeof releaseNotifications.$inferSelect;
export type FoodEntry = typeof foodEntries.$inferSelect;
export type StravaConnection = typeof stravaConnections.$inferSelect;
export type StravaActivity = typeof stravaActivities.$inferSelect;

export const fitnessActivities = assistantTable(
  "fitness_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    sportType: text("sport_type").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    distanceM: integer("distance_m").notNull().default(0),
    movingTimeS: integer("moving_time_s").notNull().default(0),
    elapsedTimeS: integer("elapsed_time_s").notNull().default(0),
    elevationGainM: integer("elevation_gain_m").notNull().default(0),
    averageHeartrate: integer("average_heartrate"),
    maxHeartrate: integer("max_heartrate"),
    calories: integer("calories"),
    trainingLoad: integer("training_load"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(emptyJson),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    // Set once the coach has commented on the workout (or decided it is a duplicate).
    coachReviewedAt: timestamp("coach_reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("fitness_activities_source_external_idx").on(table.source, table.externalId),
    index("fitness_activities_user_start_idx").on(table.userId, table.startAt),
  ],
);

export const wellnessDays = assistantTable(
  "wellness_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    day: text("day").notNull(),
    restingHr: integer("resting_hr"),
    hrv: integer("hrv"),
    sleepSecs: integer("sleep_secs"),
    sleepScore: integer("sleep_score"),
    steps: integer("steps"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("wellness_days_user_source_day_idx").on(table.userId, table.source, table.day),
  ],
);

export const integrationSyncState = assistantTable("integration_sync_state", {
  key: text("key").primaryKey(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
});

// Browser/home-screen access without Telegram: a device asks, the owner approves in the bot.
export const webSessions = assistantTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    code: text("code").notNull(),
    // pending | active | denied | revoked
    status: text("status").notNull().default("pending"),
    device: text("device"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("web_sessions_token_hash_uq").on(table.tokenHash)],
);

export type WebSession = typeof webSessions.$inferSelect;

// The in-app coach: the owner's own training history/goals text plus settings (FTP...).
export const coachProfiles = assistantTable("coach_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  profile: text("profile").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(emptyJson),
  ...timestamps,
});

export const coachMessages = assistantTable(
  "coach_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // user | assistant
    role: text("role").notNull(),
    content: text("content").notNull(),
    // active | archived ("Новый разговор" archives the old thread)
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [index("coach_messages_user_created_idx").on(table.userId, table.createdAt)],
);

// Power data the watch never sees: summaries of FIT files from Magene/Zwift.
export const rideFiles = assistantTable(
  "ride_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    fileName: text("file_name"),
    source: text("source").notNull().default("upload"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [index("ride_files_user_started_idx").on(table.userId, table.startedAt)],
);

export type CoachMessage = typeof coachMessages.$inferSelect;
export type RideFile = typeof rideFiles.$inferSelect;
export type FitnessActivity = typeof fitnessActivities.$inferSelect;
export type WellnessDay = typeof wellnessDays.$inferSelect;

export const nutritionGoals = assistantTable("nutrition_goals", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  calories: integer("calories").notNull().default(2100),
  proteinG: integer("protein_g").notNull().default(150),
  fatG: integer("fat_g").notNull().default(70),
  carbsG: integer("carbs_g").notNull().default(215),
  workoutPercent: integer("workout_percent").notNull().default(50),
  ...timestamps,
});

// Everything the owner has in progress: what it is, where it stands, what is next.
export const projects = assistantTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // active | waiting | paused | done
    status: text("status").notNull().default("active"),
    // Who or what the project waits for while status = waiting.
    waitingFor: text("waiting_for"),
    // "Where it stands" in a few lines; written by hand now, by the model later.
    summary: text("summary"),
    // owner/name on GitHub, so commits and Claude Code reports find the project.
    repo: text("repo"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("projects_user_activity_idx").on(table.userId, table.lastActivityAt),
    uniqueIndex("projects_user_repo_uq")
      .on(table.userId, table.repo)
      .where(sql`${table.repo} is not null`),
  ],
);

// The project's log: done = already happened, todo = ahead (closed once done), note = context.
export const projectEntries = assistantTable(
  "project_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // done | todo | note
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    // manual | github | claude_code | ai
    source: text("source").notNull().default("manual"),
    // A commit sha or a session id: the same report never lands twice.
    externalId: text("external_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when a todo is done.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("project_entries_project_occurred_idx").on(table.projectId, table.occurredAt),
    uniqueIndex("project_entries_source_external_uq")
      .on(table.projectId, table.source, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

// The latest report of one Claude Code session, waiting to become log lines. The raw text
// is dropped once processed; done/next keep what the session has reported so far.
export const projectSessionReports = assistantTable(
  "project_session_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedHash: text("processed_hash"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    done: text("done"),
    next: jsonb("next").$type<string[]>().notNull().default(emptyArrayJson),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("project_session_reports_user_session_uq").on(table.userId, table.sessionId),
    index("project_session_reports_received_idx").on(table.receivedAt),
  ],
);

export type Project = typeof projects.$inferSelect;
export type ProjectEntry = typeof projectEntries.$inferSelect;
export type ProjectSessionReport = typeof projectSessionReports.$inferSelect;
