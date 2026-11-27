// The slice of omp's settings registry this plugin reads. The module exists only inside omp, so the typecheck needs this declaration.
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export interface Setting {
		get(scope: unknown): string;
		listen(scope: unknown, callback: (next: string) => void): unknown;
	}
	export function lookup(id: string): Setting | undefined;
}

declare module "@oh-my-pi/pi-coding-agent/extensibility/plugins" {
	export function getPluginSettings(name: string, cwd: string): Promise<unknown>;
}
