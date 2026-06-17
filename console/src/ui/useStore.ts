import { useEffect, useState } from 'preact/hooks';

import type { ConsoleStore } from '../store';

/** Subscribes a component to the store and re-renders on change. */
export function useStore(store: ConsoleStore): ConsoleStore {
  const [, setVersion] = useState(0);
  useEffect(() => store.subscribe(() => setVersion((v) => v + 1)), [store]);
  return store;
}
