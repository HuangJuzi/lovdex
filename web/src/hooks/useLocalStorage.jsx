import { useState } from 'react';

/**
 * Hook to persist state in localStorage.
 *
 * @template T
 * @param {string} key The key to use for localStorage.
 * @param {T} initialValue The initial value to use if nothing is in localStorage.
 * @returns {[T, (value: T | ((prev: T) => T)) => void]} A tuple containing the
 *   stored value and a setter function (which also accepts an updater function).
 */
function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.log(error);
      return initialValue;
    }
  });

  const setValue = (value) => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const valueToStore =
        value instanceof Function ? value(storedValue) : value;
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
      setStoredValue(valueToStore);
    } catch (error) {
      console.log(error);
    }
  };

  return [storedValue, setValue];
}

export default useLocalStorage;
