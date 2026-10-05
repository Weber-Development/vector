/**
 * True if an event type matches a filter entry: exact (`invoice.paid`), a prefix wildcard
 * (`invoice.*` matches `invoice.paid` and `invoice.line.added`) or everything (`*`).
 */
export function matchesEventType(filter: string, eventType: string): boolean {
  if (filter === "*" || filter === eventType) return true;
  if (filter.endsWith(".*")) return eventType.startsWith(filter.slice(0, -1));
  return false;
}

/** True if an endpoint with these filters should receive the event. `null` means all events. */
export function endpointWants(filters: string[] | null, eventType: string): boolean {
  return filters === null || filters.some((filter) => matchesEventType(filter, eventType));
}

const EVENT_TYPE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

export function assertEventType(eventType: string): void {
  if (!EVENT_TYPE.test(eventType) || eventType.length > 200) {
    throw new TypeError(
      `Invalid event type "${eventType}". Use dot-separated names like invoice.paid.`,
    );
  }
}

export function assertEventTypeFilter(filter: string): void {
  if (filter === "*") return;
  assertEventType(filter.endsWith(".*") ? filter.slice(0, -2) : filter);
}
