import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// A real executable is needed: a shell script's interpreter replaces its argv[0].
export function argvProbe(dir: string, variables: string[] = []): string {
  const source = join(dir, "stub.c"), binary = join(dir, "kata");
  const fields = variables.map((name, i) => `const char *v${i} = getenv("${name}");`).join(" ");
  const values = variables.map((_, i) => `v${i} ? v${i} : ""`).join(", ");
  writeFileSync(source, `#include <stdio.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { ${fields} printf("%s${"/%s".repeat(variables.length)}\\n", argv[0]${values ? `, ${values}` : ""}); return 0; }\n`);
  expect(Bun.spawnSync([Bun.which("cc")!, source, "-o", binary]).exitCode).toBe(0);
  return binary;
}
