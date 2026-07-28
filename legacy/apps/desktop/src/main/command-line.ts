/**
 * Split the command field into argv without invoking a shell.
 *
 * Quotes preserve whitespace and are removed. A backslash escapes whitespace,
 * quotes, or another backslash; before any other character it remains a path
 * separator. This keeps Windows paths intact while still allowing a literal
 * quote. Shell operators have no special meaning and travel as ordinary argv.
 */
export const parseCommandLine = (source: string): string[] => {
  if (source.includes("\0")) throw new Error("a command cannot contain NUL");

  const argv: string[] = [];
  let part = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && character === "\\") {
        const next = source[index + 1];
        if (next === '"' || next === "\\") {
          part += next;
          index += 1;
          continue;
        }
      }
      part += character;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        argv.push(part);
        part = "";
        started = false;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (character === "\\") {
      const next = source[index + 1];
      if (
        next !== undefined &&
        (/\s/.test(next) || next === '"' || next === "'" || next === "\\")
      ) {
        part += next;
        started = true;
        index += 1;
        continue;
      }
    }

    part += character;
    started = true;
  }

  if (quote !== null) throw new Error(`unterminated ${quote} quote in command`);
  if (started) argv.push(part);
  if (argv.length === 0 || argv[0] === "") throw new Error("a command needs an executable");
  return argv;
};
