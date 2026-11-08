import { existsSync, readFileSync } from "node:fs";

/** The records of a JSONL file the smoke run writes; none while it does not exist yet. */
export function linesIn<T>(file: string | undefined): T[] {
	return file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
