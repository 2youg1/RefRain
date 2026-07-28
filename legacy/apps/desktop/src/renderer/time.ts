/**
 * Instants are stored in UTC and shown in the author's clock.
 *
 * `decidedAt`, `at`, and every other stamp in this application is an ISO
 * instant, which is the right thing to write down: a Verdict recorded in Tokyo
 * and read in Berlin is the same moment, and only an absolute instant survives
 * the trip. What went wrong was the display. Two surfaces each rendered the
 * stored string their own way, and both showed UTC — the Ledger by slicing the
 * first sixteen characters, the Edits panel by slicing characters 11 to 16 —
 * so a judgment made at nine in the evening in Tokyo read as noon, and an edit
 * made after breakfast in Los Angeles was stamped with the previous day.
 *
 * Conversion lives here rather than in each component because the two of them
 * drifted apart once already: fixing the Ledger left the Edits panel showing
 * UTC for another release. One authority means the next surface that shows a
 * time either uses it or is visibly not using it.
 *
 * A stamp that will not parse is returned unchanged. It is a record either
 * way, and showing the raw value beats showing "Invalid Date" over data the
 * author cannot correct from here.
 */

/** Clock time, for stamps whose day is already obvious from context. */
export const localTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

/** Date and clock time, for a record read long after it was written. */
export const localDateTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};
