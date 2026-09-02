export type ListProject = {
  id: string;
  name: string;
  repo_url: string;
  created_at: string;
};

export type ListEnv = {
  id: string;
  project_id: string;
  name: string;
  web_base_url: string;
  grpc_address: string;
  vars: Record<string, string>;
  credentials: Record<string, string>;
};

declare global {
  interface Window {
    __TAURI__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

export async function invoke_list_projects(addr: string): Promise<ListProject[]> {
  return window.__TAURI__.invoke('list_projects', { addr }) as Promise<ListProject[]>;
}

export async function invoke_list_envs(addr: string, projectId: string): Promise<ListEnv[]> {
  return window.__TAURI__.invoke('list_envs', { addr, projectId }) as Promise<ListEnv[]>;
}
