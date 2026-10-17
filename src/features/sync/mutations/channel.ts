/**
 * Tells a page's other tabs that the client committed, through a BroadcastChannel where the page has one; elsewhere
 * nothing is sent and nothing is heard.
 */
export interface ChangeChannel {
  post(): void;
  listen(listener: () => void): () => void;
  close(): void;
}

/** The channel named `name`. */
export function changeChannel(name: string): ChangeChannel {
  const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (Channel === undefined) return { post: () => undefined, listen: () => () => undefined, close: () => undefined };
  const channel = new Channel(name);
  return {
    post: () => channel.postMessage('changed'),
    listen: (listener) => {
      const handler = (): void => listener();
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    close: () => channel.close(),
  };
}
