import { useState, useEffect } from 'react';
import TopBar from './components/TopBar';
import { invoke_list_projects, invoke_list_envs } from './lib/ipc';

type ListEnv = {
  id: string;
  name: string;
};

function App() {
  const [serverAddr, setServerAddr] = useState(() => {
    return localStorage.getItem('hpath.serverAddr') || '127.0.0.1:50051';
  });
  const [appliedServerAddr, setAppliedServerAddr] = useState(serverAddr);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<ListEnv[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'connecting' | 'offline'>('offline');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConnectionStatus('connecting');
    setEnvs([]);
    (async () => {
      try {
        await invoke_list_projects(appliedServerAddr);
        if (cancelled) return;
        setConnectionStatus('connected');
      } catch {
        if (!cancelled) setConnectionStatus('offline');
        return;
      }
      if (!selectedProjectId) return;
      try {
        const envList = await invoke_list_envs(appliedServerAddr, selectedProjectId);
        if (!cancelled) setEnvs(envList);
      } catch {
        if (!cancelled) setEnvs([]);
      }
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [appliedServerAddr, selectedProjectId]);

  useEffect(() => {
    setSelectedEnvId(null);
  }, [selectedProjectId]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        projects={[]}
        envs={envs}
        selectedProjectId={selectedProjectId}
        selectedEnvId={selectedEnvId}
        connectionStatus={connectionStatus}
        serverAddr={serverAddr}
        onSelectProject={setSelectedProjectId}
        onSelectEnv={setSelectedEnvId}
        onServerAddrChange={setServerAddr}
        onApply={() => {
          localStorage.setItem('hpath.serverAddr', serverAddr);
          setAppliedServerAddr(serverAddr);
        }}
      />
      <main style={{ flex: 1, padding: '1rem' }}>
        <p>Views land in T11+</p>
      </main>
    </div>
  );
}

export default App;
