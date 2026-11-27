// The warning explains the completed call while keeping the guard's reason.
export const guardWarning = (tool: string, ref: string) => `This ${tool} call asked to put ${ref} into the repository. Kata refs only resolve in the local tracker, so code, comments, tests, docs and commit messages should describe the behaviour instead. To turn this check off, set KATA_REF_GUARD=off.`;
