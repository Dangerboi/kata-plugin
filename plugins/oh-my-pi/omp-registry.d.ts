// The slice of omp's settings registry this plugin reads. The module exists only inside omp, so the typecheck needs this declaration.
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export function lookup(id: string): { get(scope: unknown): string; listen(scope: unknown, callback: (next: string, previous: string) => void): unknown } | undefined;
}
