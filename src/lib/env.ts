// Lexim i variablave të mjedisit. Dështon herët dhe qartë nëse mungon diçka.
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Mungon variabla e mjedisit: ${name}`);
  return v;
}

export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
