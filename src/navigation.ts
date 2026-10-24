export type AppRoute = { page: 'home' } | { page: 'workspace' } | { page: 'room'; roomId: string };

export function routeFromHash(hash: string): AppRoute {
  if (hash === '#/workspace') return { page: 'workspace' };
  const match = /^#\/rooms\/([a-zA-Z0-9-]+)$/.exec(hash);
  return match ? { page: 'room', roomId: match[1] } : { page: 'home' };
}

export function routeHash(route: AppRoute): string {
  return route.page === 'room'
    ? `#/rooms/${route.roomId}`
    : route.page === 'workspace'
      ? '#/workspace'
      : '#/';
}
