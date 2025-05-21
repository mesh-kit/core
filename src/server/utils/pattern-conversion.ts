/**
 * Converts a regex pattern or glob pattern to a SQL LIKE pattern
 *
 * This handles:
 * - Regex anchors (^ and $)
 * - Wildcard characters (* and ?)
 * - Regex dot (.)
 * - Regex plus (+)
 * - Escaped characters (e.g., \., \*, \+, \?)
 *
 * @param pattern The pattern to convert
 * @returns A SQL LIKE pattern
 */
export function convertToSqlPattern(pattern: string): string {
  return pattern
    .replace(/\^/g, "") // remove start anchor
    .replace(/\$/g, "") // remove end anchor
    .replace(/\./g, "_") // . becomes _
    .replace(/\*/g, "%") // * becomes %
    .replace(/\+/g, "%") // + becomes %
    .replace(/\?/g, "_") // ? becomes _
    .replace(/\\\\/g, "\\") // unescape backslashes
    .replace(/\\\./g, ".") // unescape dots
    .replace(/\\\*/g, "*") // unescape asterisks
    .replace(/\\\+/g, "+") // unescape plus signs
    .replace(/\\\?/g, "?");
}
