export function canRunLorebookSweep(completedSweeps: number, maxSteps: number): boolean {
    return maxSteps <= 0 || completedSweeps < maxSteps
}
