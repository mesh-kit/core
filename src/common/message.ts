export interface Command {
  id?: number;
  command: string;
  payload: any;
}

export function parseCommand(data: string): Command {
  try {
    return JSON.parse(data) as Command;
  } catch (e) {
    return { command: "", payload: {} };
  }
}

export function stringifyCommand(command: Command): string {
  return JSON.stringify(command);
}
