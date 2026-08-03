/**
 * Formatting for `<input type="date">`.
 *
 * The trap this exists to close: a date input silently renders **blank** if its
 * value is not exactly `yyyy-MM-dd`. Hand it `2026-09-12T00:00:00.000Z` and the
 * field appears empty — so a race date that was saved perfectly well looked to
 * the athlete as though it had never stuck, and they retyped it every visit.
 *
 * Three pages each converted the value themselves, and each did it in some code
 * paths but not others. Normalising at the point of use means it cannot drift
 * again, whatever a loader happens to put in state.
 */

/**
 * @param value a Date, an ISO string, a plain yyyy-MM-dd, null or undefined.
 * @returns yyyy-MM-dd, or "" when there is genuinely no date.
 */
export function toDateInput(value: unknown): string {
  if (value == null || value === "") return "";

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : localDatePart(value);
  }

  if (typeof value === "string") {
    // Already in the right shape.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    // ISO timestamps: take the calendar date as written, not as converted.
    // Reparsing "2026-09-12T00:00:00.000Z" through a positive-offset timezone
    // would shift it to the 11th.
    const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
    if (iso) return iso[1];

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : localDatePart(parsed);
  }

  return "";
}

function localDatePart(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}
