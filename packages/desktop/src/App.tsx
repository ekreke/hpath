import { useCallback, useEffect, useState } from 'react';
import Sidebar, { type ViewId } from './components/Sidebar';
import TopBar from './components/TopBar';
import { Toast } from './components/Ui';
import CasesView from './views/CasesView';
import ChatView from './views/ChatView';
import EnvsView from './views/EnvsView';
import HistoryView from './views/HistoryView';
import PrdView from './views/PrdView';
import {
  invokeListEnvs,
  invokeListProjects,
  invokeSetServerAddr,
  type Env,
  type Project,
} from './lib/ipc';
import { useTranslation } from 'react-i18next';

function App() {
  const { t } = useTranslation();
  const [serverAddr, setServerAddr] = useState(
    () => localStorage.getItem('hpath.serverAddr') || '127.0.0.1:50051',
  );
  const [appliedServerAddr, setAppliedServerAddr] = useState(serverAddr);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>('chat');
  const [connectionStatus, setConnectionStatus] = useState<
    'connected' | 'connecting' | 'offline'
  >('offline');
  const [caseCount, setCaseCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const onToast = useCallback((text: string, error?: boolean) => {
    setToast({ text, error });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setConnectionStatus('connecting');
    setEnvs([]);
    setSelectedEnvId(null);
    (async () => {
      try {
        await invokeSetServerAddr(appliedServerAddr);
        const list = await invokeListProjects();
        if (cancelled) return;
        setProjects(list);
        setConnectionStatus('connected');
        setSelectedProjectId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null),
        );
      } catch (err) {
        if (!cancelled) {
          setProjects([]);
          setSelectedProjectId(null);
          setConnectionStatus('offline');
          onToast(String(err), true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appliedServerAddr, onToast]);

  useEffect(() => {
    if (!selectedProjectId) {
      setEnvs([]);
      setSelectedEnvId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await invokeListEnvs(selectedProjectId);
        if (cancelled) return;
        setEnvs(list);
        setSelectedEnvId((prev) =>
          prev && list.some((e) => e.id === prev) ? prev : null,
        );
      } catch {
        if (!cancelled) setEnvs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appliedServerAddr, selectedProjectId, refreshKey]);

  const refreshEnvs = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const viewLabel = t(`sidebar.${view === 'prd' ? 'prdDocs' : view === 'history' ? 'runHistory' : view}`);

  return (
    <div className="shell">
      <Sidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        view={view}
        connectionStatus={connectionStatus}
        serverAddr={appliedServerAddr}
        caseCount={caseCount}
        envCount={envs.length}
        onSelectProject={setSelectedProjectId}
        onSelectView={setView}
      />
      <div className="main">
        <TopBar
          projectName={selectedProject?.name ?? null}
          viewLabel={viewLabel}
          envs={envs}
          selectedEnvId={selectedEnvId}
          serverAddr={serverAddr}
          onSelectEnv={setSelectedEnvId}
          onServerAddrChange={setServerAddr}
          onApply={() => {
            localStorage.setItem('hpath.serverAddr', serverAddr);
            setAppliedServerAddr(serverAddr);
          }}
        />
        <div className="page">
          {view === 'chat' && (
            <ChatView
              projectId={selectedProjectId}
              envs={envs}
              onToast={onToast}
            />
          )}
          {view === 'cases' && (
            <CasesView
              appliedServerAddr={appliedServerAddr}
              projectId={selectedProjectId}
              envs={envs}
              selectedEnvId={selectedEnvId}
              refreshKey={refreshKey}
              onToast={onToast}
              onCountChange={setCaseCount}
              onOpenEnvs={() => setView('envs')}
            />
          )}
          {view === 'history' && (
            <HistoryView
              appliedServerAddr={appliedServerAddr}
              projectId={selectedProjectId}
              envs={envs}
              refreshKey={refreshKey}
              onToast={onToast}
            />
          )}
          {view === 'envs' && (
            <EnvsView
              projectId={selectedProjectId}
              envs={envs}
              onChanged={refreshEnvs}
              onToast={onToast}
            />
          )}
          {view === 'prd' && (
            <PrdView
              projectId={selectedProjectId}
              onDraftsCreated={refreshEnvs}
              onToast={onToast}
            />
          )}
        </div>
      </div>
      {toast && <Toast text={toast.text} error={toast.error} onDone={() => setToast(null)} />}
    </div>
  );
}

export default App;
