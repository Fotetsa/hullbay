import React from "react"
import ReactDOM from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter } from "react-router-dom"
import { Toaster } from "@medusajs/ui"
import "@xyflow/react/dist/style.css"
import "./index.css"
import { App } from "./App"
import { ErrorBoundary } from "./components/ErrorBoundary"
import './i18n/config'

// Defaults bornés : sans ça les erreurs réseau retentaient en boucle et chaque
// focus de fenêtre déclenchait un refetch. retry:1 + staleTime court = un outil
// d'ops réactif sans marteler l'API.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
})

if (typeof window !== "undefined") {
  import("./i18n/config").then(({ initI18n }) => initI18n());
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
