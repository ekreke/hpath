import { useCallback, useEffect, useState } from 'react';
import Sidebar, { type ViewId } from './components/Sidebar';
import TopBar from './components/TopBar';
import { Toast } from './components/Ui';
import CasesView from './views/CasesView';
import ChatView from './views/ChatView';
import EnvsView from './views/EnvsView';
import HistoryView from './views/HistoryView';
import PrdView from './views/PrdView';
import SettingsView from './views/SettingsView';
import {
  invokeListEnvs,
  invokeListProjects,
  invokeSetServerAddr,
  toFriendlyError,
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
  const [projectRefreshKey, setProjectRefreshKey] = useState(0);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const onToast = useCallback((text: string, error?: boolean) => {
    setToast({ text, error });
  }, []);

  // Called by views when the server confirms a NOT_FOUND on the currently
  // selected project (e.g. backend reset, project deleted elsewhere). Snaps
  // back to the first available project so the user isn't trapped looking at
  // a permanent error every time they switch to this view.
  const handleProjectInvalidated = useCallback(
    (invalidatedId: string) => {
      setSelectedProjectId((prev) => {
        if (prev !== invalidatedId) return prev;
        const next = projects[0]?.id ?? null;
        if (next && projects[0]) {
          onToast(t('sidebar.projectSwitched', { name: projects[0].name }));
        }
        return next;
      });
    },
    [projects, onToast, t],
  );

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
        setSelectedProjectId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          const next = list[0]?.id ?? null;
          // The previous selection no longer exists on the server (project
          // deleted, server reset, or we connected to a different backend).
          // Surface the auto-switch so the user isn't left wondering why the
          // sidebar snapped to a new project. Defer to next tick: we're inside
          // a setState updater and `onToast` mutates state of its own.
          if (prev && next && prev !== next && list[0]) {
            queueMicrotask(() =>
              onToast(t('sidebar.projectSwitched', { name: list[0].name })),
            );
          }
          return next;
        });
      } catch (err) {
        if (!cancelled) {
          setProjects([]);
          setSelectedProjectId(null);
          setConnectionStatus('offline');
          onToast(toFriendlyError(err).message, true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appliedServerAddr, onToast, projectRefreshKey, t]);

  const onProjectCreated = useCallback(
    (id: string) => {
      setSelectedProjectId(id);
      setProjectRefreshKey((k) => k + 1);
    },
    [],
  );

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
        // Keep a valid selection; otherwise fall back to the project's
        // default env so cases are runnable out of the box.
        setSelectedEnvId((prev) =>
          prev && list.some((e) => e.id === prev) ? prev : (list.find((e) => e.isDefault)?.id ?? null),
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
        envs={envs}
        selectedEnvId={selectedEnvId}
        onSelectProject={setSelectedProjectId}
        onSelectView={setView}
        onSelectEnv={setSelectedEnvId}
        onProjectCreated={onProjectCreated}
        onEnvChanged={refreshEnvs}
        onToast={onToast}
      />
      <div className="main">
        <TopBar
          projectName={selectedProject?.name ?? null}
          viewLabel={viewLabel}
        />
        <div className="page">
          {view === 'chat' && <ChatView onToast={onToast} />}
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
              onProjectInvalidated={handleProjectInvalidated}
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
          {view === 'settings' && (
            <SettingsView
              onToast={onToast}
              serverAddr={serverAddr}
              onServerAddrChange={setServerAddr}
              onApplyServer={() => {
                localStorage.setItem('hpath.serverAddr', serverAddr);
                setAppliedServerAddr(serverAddr);
              }}
              connectionStatus={connectionStatus}
            />
          )}
        </div>
      </div>
      {toast && <Toast text={toast.text} error={toast.error} onDone={() => setToast(null)} />}
    </div>
  );
}

export default App;
