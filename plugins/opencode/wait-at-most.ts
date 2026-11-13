// Waits for `promise` at most `ms`; settles undefined when the time runs out. The promise itself is never cancelled.
export function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: unknown;
	return Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(resolve, ms); })])
		.finally(() => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
}
