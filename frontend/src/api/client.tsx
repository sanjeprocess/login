import { createContext, useContext, type ReactNode } from 'react';
import { HttpApi } from './httpApi';
import { MockApi } from './mockApi';
import type { GatewayApi } from './types';
import { config } from '../config';

export function createApi(): GatewayApi {
  return config.useMockApi ? new MockApi() : new HttpApi(config.apiBaseUrl);
}

const ApiContext = createContext<GatewayApi | null>(null);

export function ApiProvider({ api, children }: { api: GatewayApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): GatewayApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}
