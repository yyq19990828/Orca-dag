import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** Page-lifetime drafts and receipts, never persisted to browser storage.
 * Each setter retains the scope in which an operation began. A late send
 * response cannot clear another Run's draft or replace another recipient's
 * receipt, even when the dock remains mounted across navigation.
 */
export function useScopedChatState<T>(scope: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const fallback = useRef(initial);
  const [values, setValues] = useState<ReadonlyMap<string, T>>(() => new Map());
  const value = values.has(scope) ? values.get(scope)! : fallback.current;
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setValues((previous) => {
      const current = previous.has(scope) ? previous.get(scope)! : fallback.current;
      const next = typeof action === "function" ? (action as (value: T) => T)(current) : action;
      if (Object.is(current, next)) return previous;
      const updated = new Map(previous);
      if (Object.is(next, fallback.current)) updated.delete(scope);
      else updated.set(scope, next);
      return updated;
    });
  }, [scope]);
  return [value, setValue];
}
