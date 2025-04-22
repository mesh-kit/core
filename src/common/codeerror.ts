export class CodeError extends Error {
  code?: string;
  name: string;

  constructor(message: string, code?: string, name?: string) {
    super(message);
    if (typeof code === "string") {
      this.code = code;
    }
    this.name = typeof name === "string" ? name : "CodeError";
  }
}
