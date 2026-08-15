import { useEffect, useState, type ComponentType } from "react"
import { NavLink, Outlet, useNavigate } from "react-router-dom"
import { Badge, Button, IconButton, Text, clx, toast } from "@medusajs/ui"
import {
  SquaresPlus,
  ChartBar,
  ServerStack,
  CircleStack,
  Key,
  CogSixTooth,
  ArrowRightOnRectangle,
  XMark,
  BarsThree,
  Users,
  DocumentText,
  ArrowPath,
  Sparkles,
} from "@medusajs/icons"
import { auth } from "../lib/api"
import { useMe, type Role } from "../lib/useMe"
import { useUpdatesCheck } from "../lib/useUpdates"
import { ThemeToggle } from "./ThemeToggle/ThemeToggle"

type NavItem = { to: string; label: string; Icon: ComponentType; min: Role }

// `min` = rôle minimum requis pour voir l'entrée (aligné sur les requireRole du
// backend). Un viewer ne voit pas Serveurs/Registres/Secrets/Utilisateurs ; le
// journal d'audit est operator+.
const NAV: NavItem[] = [
  { to: "/", label: "Projets", Icon: SquaresPlus, min: "viewer" },
  { to: "/health", label: "Santé", Icon: ChartBar, min: "viewer" },
  { to: "/audit", label: "Journal", Icon: DocumentText, min: "operator" },
  { to: "/servers", label: "Serveurs", Icon: ServerStack, min: "owner" },
  { to: "/registries", label: "Registres", Icon: CircleStack, min: "owner" },
  { to: "/secrets", label: "Secrets", Icon: Key, min: "operator" },
  { to: "/users", label: "Utilisateurs", Icon: Users, min: "owner" },
  { to: "/updates", label: "Mises à jour", Icon: ArrowPath, min: "owner" },
  { to: "/settings", label: "Paramètres", Icon: CogSixTooth, min: "viewer" },
]

/**
 * Shell applicatif responsive :
 *  - >= md : sidebar fixe (w-60) + contenu.
 *  - < md  : sidebar masquée, barre supérieure avec burger qui ouvre un panneau
 *            off-canvas (overlay). Le clic sur un lien ou l'overlay le referme.
 * Le canvas (plein écran) et le login restent hors de ce layout.
 */
// MeProvider est monté plus haut (App.tsx) pour couvrir aussi le canvas plein écran ;
// ici on consomme simplement le contexte.
export function AppLayout({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { me, can } = useMe()

  const isOwner = can("owner")
  const updates = useUpdatesCheck(isOwner)
  const updateAvailable = updates.data?.updateAvailable ?? false
  const isStableChannel = updates.data?.updateChannel === "stable"
  const isKnownVersion = (updates.data?.currentVersion ?? "unknown") !== "unknown"
  const currentVersion = updates.data?.currentVersion ?? "unknown"
  const updateChannel = updates.data?.updateChannel ?? "stable"
  // Toast discret une seule fois par version (flag localStorage), déclenché au
  // chargement du check (au login AND au refresh 6h). Canal stable uniquement,
  // et seulement si la version déployée est réellement connue (pas "unknown" :
  // install sans IMAGE_TAG → updateAvailable est systématiquement vrai).
  const latestVersion = updates.data?.latestVersion
  useEffect(() => {
    if (!updateAvailable || !isStableChannel || !isKnownVersion || !latestVersion) return
    const seenKey = `hullbay_update_seen_${latestVersion}`
    if (localStorage.getItem(seenKey)) return
    localStorage.setItem(seenKey, "1")
    toast.info(`Mise à jour ${latestVersion} disponible`, {
      description: "Ouvre Mises à jour dans la navigation pour le détail.",
    })
  }, [updateAvailable, isStableChannel, isKnownVersion, latestVersion])

  const logout = () => {
    auth.clear()
    onLogout()
    navigate("/login", { replace: true })
  }

  // Esc ferme le panneau mobile (accessibilité clavier).
  const onSidebarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setMobileOpen(false)
  }

  const visibleNav = NAV.filter((item) => can(item.min))

  const sidebar = (
    <div className="flex h-full flex-col bg-ui-bg-base">
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-ui-bg-base-pressed">
            <ServerStack />
          </div>
          <Text size="base" weight="plus">
            hullbay
          </Text>
        </div>
        {/* Fermer (mobile uniquement) */}
        <IconButton
          variant="transparent"
          size="small"
          className="md:hidden"
          aria-label="Fermer le menu"
          onClick={() => setMobileOpen(false)}
        >
          <XMark />
        </IconButton>
      </div>
      <div className="flex items-center gap-2 px-4 pt-1">
        <Text size="small" className="text-ui-fg-muted">
          {currentVersion === "unknown" ? "Version inconnue" : `${currentVersion}`}
        </Text>
        <Badge color={updateChannel === "beta" ? "purple" : "green"} size="2xsmall">
          {updateChannel === "beta" ? "Beta" : "Stable"}
        </Badge>
      </div>

      <div className="mx-3 mt-3 border-t border-ui-border-base" />
      <nav className="flex flex-1 flex-col gap-1 px-2 pt-4" aria-label="Navigation principale">
        {visibleNav.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              clx(
                "flex items-center gap-3 rounded-md px-3 py-2 text-ui-fg-subtle transition-colors",
                "hover:bg-ui-bg-base-hover hover:text-ui-fg-base",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-border-interactive",
                isActive && "bg-ui-bg-base-pressed text-ui-fg-base"
              )
            }
          >
            <Icon />
            <Text size="small" weight="plus">
              {label}
            </Text>
            {to === "/updates" && updateAvailable && isKnownVersion && (
              <Badge color="blue" size="2xsmall" className="ml-auto animate-pulse capitalize motion-reduce:animate-none">
                <Sparkles />
                Nouveau
              </Badge>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-ui-border-base p-2">
        {me && (
          <div className="flex items-center justify-between px-3 py-1">
            <Text size="xsmall" className="truncate text-ui-fg-muted" title={me.email}>
              {me.email}
            </Text>
            <Badge size="2xsmall" className="capitalize">
              {me.role}
            </Badge>
          </div>
        )}
        <ThemeToggle />
        <Button
          variant="transparent"
          size="small"
          className="w-full justify-start gap-3 text-ui-fg-subtle"
          onClick={logout}
        >
          <ArrowRightOnRectangle />
          Déconnexion
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-ui-bg-subtle">
      {/* Lien d'évitement (a11y) : saute directement au contenu au clavier. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-ui-bg-base focus:px-3 focus:py-2 focus:shadow-elevation-flyout"
      >
        Aller au contenu
      </a>

      {/* Sidebar fixe (desktop) */}
      <aside className="hidden w-60 shrink-0 border-r border-ui-border-base md:block">
        {sidebar}
      </aside>

      {/* Panneau off-canvas (mobile) */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu de navigation"
          onKeyDown={onSidebarKeyDown}
        >
          <div
            className="absolute inset-0 bg-ui-bg-overlay"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-ui-border-base shadow-elevation-flyout">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barre supérieure (mobile uniquement) avec burger */}
        <div className="flex items-center gap-2 border-b border-ui-border-base bg-ui-bg-base px-4 py-3 md:hidden">
          <IconButton
            variant="transparent"
            size="small"
            aria-label="Ouvrir le menu"
            onClick={() => setMobileOpen(true)}
          >
            <BarsThree />
          </IconButton>
          <Text size="small" weight="plus">
            hullbay
          </Text>
        </div>

        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
