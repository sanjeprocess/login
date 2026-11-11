import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout: stub the scroll helpers the screens call.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
Element.prototype.scrollIntoView = function scrollIntoView() {};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
