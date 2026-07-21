import { useState } from "react"
import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Spinner } from "@medusajs/icons"
import { api, auth } from "./lib/api"
import { AppLayout } from "./components/AppLayout"
import { LoginPage } from "./pages/LoginPage"
import { BootstrapPage } from "./pages/BootstrapPage"
import { UsersPage } from "./pages/UsersPage"
import { AuditPage } from "./pages/AuditPage"
import { MeProvider } from "./lib/useMe"
import { ProjectsPage } from "./pages/ProjectsPage"
import { CanvasPage } from "./pages/CanvasPage"
import { SettingsPage } from "./pages/SettingsPage"
import { ServersPage } from "./pages/ServersPage"
import { IntegrationsPage } from "./pages/IntegrationsPage"
import { HealthPage } from "./pages/HealthPage"
import { SecretsPage } from "./pages/SecretsPage"

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

  // MeProvider englobe TOUTES les routes authentifiées — y compris le canvas qui est
  // hors du shell AppLayout. C'est indispensable : CanvasPage utilise useMe() pour
  // gater le déploiement, donc le provider doit être au-dessus du canvas ET du layout.
  return (
    <MeProvider>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />

        {/* Canvas : plein écran, hors shell */}
        <Route path="/canvas/:projectId" element={<CanvasPage />} />

        {/* Pages internes sous le shell */}
        <Route element={<AppLayout onLogout={() => setAuthed(false)} />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/registries" element={<IntegrationsPage />} />
          <Route path="/secrets" element={<SecretsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MeProvider>
  )
}

/**
 * Aiguillage non-authentifié : interroge needs-bootstrap pour basculer entre
 * "créer le 1er compte" (installation neuve) et le login normal. Sans ça, une
 * install neuve restait coincée sur un login sans compte possible.
 */
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

  // Toute route non-login renvoie au login (deep-link préservé via state).
  if (pathname !== "/login") {
    return <Navigate to="/login" replace state={{ from: pathname }} />
  }
  return <LoginPage onAuthed={onAuthed} />
}
