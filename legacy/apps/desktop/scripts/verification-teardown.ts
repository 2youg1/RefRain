/** Terminate a verification process after releasing every resource it owns. */
export const terminateAfterCleanup = (
  code: number,
  cleanup: () => void,
  exit: (code: number) => void,
  report: (message: string) => void = console.error,
): void => {
  let outcome = code;
  try {
    cleanup();
  } catch (error) {
    outcome = 1;
    report(`cleanup failed: ${String(error)}`);
  } finally {
    exit(outcome);
  }
};
