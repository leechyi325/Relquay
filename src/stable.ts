/** Keeps the previous value when polled data is unchanged, so periodic refreshes do not re-render the page. */
export function same<T>(next: T) { const key = JSON.stringify(next); return <P extends T | undefined>(previous: P): T | P => previous !== undefined && JSON.stringify(previous) === key ? previous : next; }
