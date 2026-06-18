import { useEffect, useState } from 'preact/hooks';

import type { ConsoleStore } from '../store';

/**
 * Subscribes a component to the store and re-renders on change.
 *
 * The subscription is established in an effect (after the first paint), but the
 * store can change in the gap between that render and the effect running — e.g.
 * the initial async `GET /sessions` resolving on a fast same-origin connection.
 * We re-render once immediately after subscribing so that first update is never
 * missed (the standard external-store subscription pattern).
 */
export function useStore(store: ConsoleStore): ConsoleStore {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const rerender = () => setVersion((v) => v + 1);
    const unsubscribe = store.subscribe(rerender);
    rerender(); // catch any change that happened before this subscription
    return unsubscribe;
  }, [store]);
  return store;
}
