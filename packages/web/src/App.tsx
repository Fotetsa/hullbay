import { useState, type ReactNode } from "react"
import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Spinner } from "@medusajs/icons"
import { api, auth } from "./lib/api"
import { AppLayout } from "./components/AppLayout"
import { LoginPage } from "./pages/LoginPage"
import { BootstrapPage } from "./pages/BootstrapPage"
import { ActivateMfaPage } from "./pages/ActivateMfaPage"
import { SetupDomainPage } from "./pages/SetupDomainPage"
import { UsersPage } from "./pages/UsersPage"
import { AuditPage } from "./pages/AuditPage"
import { MeProvider, useMe } from "./lib/useMe"
import { ProjectsPage } from "./pages/ProjectsPage"
import { CanvasPage } from "./pages/CanvasPage"
import { SettingsPage } from "./pages/SettingsPage"
import { ServersPage } from "./pages/ServersPage"
import { IntegrationsPage } from "./pages/IntegrationsPage"
import { HealthPage } from "./pages/HealthPage"
import { SecretsPage } from "./pages/SecretsPage"
import { UpdatesPage } from "./pages/UpdatesPage"
import { ClusterDetailPage } from "./pages/ClusterDetailPage";
import { ClustersPage } from "./pages/ClustersPage";

/**
 * Routing par URL (react-router) :
 *  - non authentifié -> /login (toutes les autres routes y redirigent)
 *  - le canvas est PLEIN ÉCRAN, hors du shell (pas de sidebar)
 *  - les autres pages sont rendues sous AppLayout (sidebar + Outlet)
 */
export function App() {
  const [authed, setAuthed] = useState<boolean>(!!auth.token)
  const location = useLocation()

  if (!authed) {
    return <UnauthedGate onAuthed={() => setAuthed(true)} pathname={location.pathname} />
  }

  return (
    <MeProvider>
      <DomainGate onUnauthenticated={() => setAuthed(false)}>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/setup-domain" element={<SetupDomainPage />} />
          <Route path="/activate-mfa" element={<ActivateMfaPage />} />

          <Route path="/canvas/:projectId" element={<CanvasPage />} />

          <Route element={<AppLayout onLogout={() => setAuthed(false)} />}>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/clusters" element={<ClustersPage />} />
            <Route path="/clusters/:clusterId"element={<ClusterDetailPage />}/>
            <Route path="/registries" element={<IntegrationsPage />} />
            <Route path="/secrets" element={<SecretsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/updates" element={<UpdatesPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />

          <Route path="/clusters/:clusterId" element={<ClusterDetailPage />} />
        </Routes>
      </DomainGate>
    </MeProvider>
  );
}

function DomainGate({ children, onUnauthenticated }: { children: ReactNode; onUnauthenticated: () => void }) {
  const location = useLocation()
  const { data, isLoading, isError: domainError, error: domainErrorObj } = useQuery<{ domain: string }>({
    queryKey: ["domain"],
    queryFn: () => api.getDomain(),
    staleTime: 0,
  })

  const { me, isLoading: meLoading, isError: meError, error: meErrorObj } = useMe()

  const isAuthError = (err: unknown) => {
    if (!err || typeof err !== "object") return false
    const status = (err as { status?: number }).status
    const code = (err as { code?: string }).code
    return (
      status === 401 ||
      status === 403 ||
      code === "unauthorized" ||
      code === "forbidden" ||
      code === "unauthenticated" ||
      code === "invalid_token"
    )
  }

  if (isLoading || meLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Spinner className="animate-spin text-ui-fg-muted" />
      </div>
    )
  }

  if (meError) {
    if (isAuthError(meErrorObj)) {
      auth.clear()
      onUnauthenticated()
      return <Navigate to="/login" replace />
    }
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <div className="text-center">
          <p className="mb-2 text-ui-fg-base">Impossible de charger tes informations de compte.</p>
          <p className="text-ui-fg-subtle">Vérifie ta connexion et réessaie.</p>
        </div>
      </div>
    )
  }

  if (domainError) {
    const domainErr = domainErrorObj as { status?: number; code?: string } | null
    const mfaPending = domainErr?.code === "mfa_not_enabled"
    // 403 mfa_not_enabled ≠ session morte : l'utilisateur doit simplement passer
    // par la MFA. On ne déconnecte PAS, on laisse la MFA-gate ci-dessous rediriger.
    if (!mfaPending && isAuthError(domainErr)) {
      auth.clear()
      onUnauthenticated()
      return <Navigate to="/login" replace />
    }
    if (!mfaPending) {
      return (
        <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
          <div className="text-center">
            <p className="mb-2 text-ui-fg-base">Impossible de charger la configuration du domaine.</p>
            <p className="text-ui-fg-subtle">Vérifie la connexion au backend et réessaie.</p>
          </div>
        </div>
      )
    }
  }

  const hasDomain = Boolean(data?.domain)

  if (me && !me.mfaEnabled && location.pathname !== "/activate-mfa") {
    return <Navigate to="/activate-mfa" replace />
  }

  if (me?.mfaEnabled) {
    if (!hasDomain && location.pathname !== "/setup-domain") {
      return <Navigate to="/setup-domain" replace />
    }

    if (hasDomain && location.pathname === "/setup-domain") {
      return <Navigate to="/" replace />
    }
  }

  return <>{children}</>
}

function UnauthedGate({
  onAuthed,
  pathname,
}: {
  onAuthed: () => void
  pathname: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["needs-bootstrap"],
    queryFn: api.needsBootstrap,
    staleTime: 0,
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Spinner className="animate-spin text-ui-fg-muted" />
      </div>
    )
  }

  if (data?.needsBootstrap) {
    return <BootstrapPage onAuthed={onAuthed} />
  }

  if (pathname !== "/login") {
    return <Navigate to="/login" replace state={{ from: pathname }} />
  }
  return <LoginPage onAuthed={onAuthed} />
}

