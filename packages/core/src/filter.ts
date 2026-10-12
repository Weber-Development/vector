import type { FilterCondition, PayloadFilter } from "./types";

const OPS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "exists",
  "prefix",
  "contains",
]);
const MAX_DEPTH = 5;
const MAX_CONDITIONS = 50;

/** Checks the shape of a filter and returns a copy. Throws a `TypeError` for anything else. */
export function validateFilter(filter: unknown): PayloadFilter {
  let conditions = 0;
  const walk = (node: unknown, depth: number): PayloadFilter => {
    if (depth > MAX_DEPTH) throw new TypeError(`A filter may nest at most ${MAX_DEPTH} levels.`);
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new TypeError("A filter must be an object.");
    }
    const record = node as Record<string, unknown>;
    for (const key of ["and", "or"] as const) {
      if (key in record) {
        const list = record[key];
        if (!Array.isArray(list) || list.length === 0) {
          throw new TypeError(`"${key}" needs a non-empty array of filters.`);
        }
        return { [key]: list.map((child) => walk(child, depth + 1)) } as PayloadFilter;
      }
    }
    if ("not" in record) return { not: walk(record.not, depth + 1) };
    if (++conditions > MAX_CONDITIONS) {
      throw new TypeError(`A filter may have at most ${MAX_CONDITIONS} conditions.`);
    }
    const { path, op, value } = record as Partial<FilterCondition>;
    if (typeof path !== "string" || path === "" || path.length > 200) {
      throw new TypeError("A condition needs a path of 1 to 200 characters.");
    }
    if (typeof op !== "string" || !OPS.has(op)) {
      throw new TypeError(`Unknown operator "${String(op)}".`);
    }
    if ((op === "in" || op === "nin") && !Array.isArray(value)) {
      throw new TypeError(`"${op}" needs an array as value.`);
    }
    if ((op === "prefix" || op === "contains") && typeof value !== "string") {
      throw new TypeError(`"${op}" needs a string as value.`);
    }
    if (
      ["gt", "gte", "lt", "lte"].includes(op) &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw new TypeError(`"${op}" needs a number or a string as value.`);
    }
    if (op !== "exists" && value === undefined) throw new TypeError(`"${op}" needs a value.`);
    return value === undefined ? { path, op } : ({ path, op, value } as FilterCondition);
  };
  return walk(filter, 1);
}

function lookup(payload: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === "object" && JSON.stringify(a) === JSON.stringify(b));
}

function check(condition: FilterCondition, payload: unknown): boolean {
  const { found, value } = lookup(payload, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case "exists":
      return found === (expected !== false);
    case "eq":
      return found && same(value, expected);
    case "ne":
      return !found || !same(value, expected);
    case "in":
      return found && (expected as unknown[]).some((item) => same(value, item));
    case "nin":
      return !found || !(expected as unknown[]).some((item) => same(value, item));
    case "prefix":
      return typeof value === "string" && value.startsWith(expected as string);
    case "contains":
      if (typeof value === "string") return value.includes(expected as string);
      return Array.isArray(value) && value.some((item) => item === expected);
    default: {
      if (!found) return false;
      const order = compare(value, expected);
      if (order === undefined) return false;
      if (condition.op === "gt") return order > 0;
      if (condition.op === "gte") return order >= 0;
      if (condition.op === "lt") return order < 0;
      return order <= 0;
    }
  }
}

/** True when the payload matches the filter. A missing field never matches, except for `ne`, `nin` and `exists: false`. */
export function matchesFilter(filter: PayloadFilter | null | undefined, payload: unknown): boolean {
  if (!filter) return true;
  if ("and" in filter) return filter.and.every((child) => matchesFilter(child, payload));
  if ("or" in filter) return filter.or.some((child) => matchesFilter(child, payload));
  if ("not" in filter) return !matchesFilter(filter.not, payload);
  return check(filter, payload);
}
