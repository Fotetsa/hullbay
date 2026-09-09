import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Tests E2E pour la gestion des clusters.
 * Stratégie : Mock strict avec nettoyage des routes pour éviter tout conflit entre les tests.
 */

const OWNER = {
  id: "owner-1",
  email: "owner@hbox.local",
  role: "owner",
  mfaEnabled: true,
};

const CLUSTERS = [
  { id: "default-cluster", name: "Default", isDefault: true, status: "ready" },
  { id: "c1", name: "Cluster EU-2", isDefault: false, status: "ready" },
  { id: "c2", name: "Cluster Test", isDefault: false, status: "failed" },
];

const SERVERS_RESPONSE = {
  servers: [
    {
      id: "s1",
      name: "manager-1",
      host: "203.0.113.10",
      port: 22,
      user: "root",
      role: "manager",
      status: "ready",
      swarmNodeId: "node1",
      lastError: null,
      clusterId: "default-cluster",
      systemInfo: null,
    },
    {
      id: "s2",
      name: "manager-eu2",
      host: "203.0.113.20",
      port: 22,
      user: "root",
      role: "manager",
      status: "ready",
      swarmNodeId: "node2",
      lastError: null,
      clusterId: "c1",
      systemInfo: null,
    },
    {
      id: "s3",
      name: "worker-test",
      host: "203.0.113.30",
      port: 22,
      user: "root",
      role: "worker",
      status: "error",
      swarmNodeId: null,
      lastError: "connexion refusée",
      clusterId: "c2",
      systemInfo: null,
    },
  ],
  swarmNodes: 2,
  managers: { total: 2, reachable: 2, quorumOk: true },
};

const HEALTH_RESPONSE = {
  clusters: [
    {
      clusterId: "default-cluster",
      clusterName: "Default",
      swarmActive: true,
      nodes: [
        {
          clusterId: "default-cluster",
          swarmNodeId: "node1",
          hostname: "manager-1",
          role: "manager",
          state: "ready",
          availability: "active",
          leader: true,
        },
      ],
      services: [],
    },
    {
      clusterId: "c1",
      clusterName: "Cluster EU-2",
      swarmActive: true,
      nodes: [
        {
          clusterId: "c1",
          swarmNodeId: "node2",
          hostname: "manager-eu2",
          role: "manager",
          state: "ready",
          availability: "active",
          leader: true,
        },
      ],
      services: [],
    },
    {
      clusterId: "c2",
      clusterName: "Cluster Test",
      swarmActive: false,
      nodes: [],
      services: [],
    },
  ],
};

type Handler = (route: Route) => void;

async function stubApi(page: Page, overrides: Record<string, Handler> = {}) {
  await page.unrouteAll();

  const handlers: Record<string, Handler> = {
    "GET /api/system/environment": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ environment: "development" }),
      }),
    "GET /api/auth/me": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(OWNER),
      }),
    "GET /api/clusters": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CLUSTERS),
      }),
    "GET /api/servers": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SERVERS_RESPONSE),
      }),
    "GET /api/health/cluster": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_RESPONSE),
      }),
    ...overrides,
  };

  await page.route("**/api/**", (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.continue();
    }

    const url = new URL(route.request().url());
    const pathname = url.pathname.replace(/\/$/, "");
    const key = `${route.request().method()} ${pathname}`;
    const handler = handlers[key];

    if (handler) {
      return handler(route);
    }

    // Bloquer les autres requêtes non mockées pour éviter les fuites vers le backend
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "non stubé" }),
    });
  });
}

async function login(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("hullbay_token", "e2e-token");
  });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("affiche la liste des clusters, avec statut et nombre de serveurs", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters");

  // Attendre qu'un élément de la liste soit visible est plus fiable que le titre
  // au premier test (démarrage à froid du serveur Vite).
  await expect(page.getByTestId("cluster-row-default-cluster")).toBeVisible({
    timeout: 15000,
  });

  await expect(page.getByTestId("cluster-row-default-cluster")).toContainText(
    "Default",
  );
  await expect(page.getByTestId("cluster-row-c1")).toContainText(
    "Cluster EU-2",
  );
  await expect(page.getByTestId("cluster-row-c2")).toContainText(
    "Cluster Test",
  );
  await expect(page.getByTestId("cluster-row-c2")).toContainText(
    /failed|échec/i,
  );
});

test("la recherche filtre la liste par nom", async ({ page }) => {
  await stubApi(page);
  await page.goto("/clusters");

  await expect(page.getByTestId("cluster-row-default-cluster")).toBeVisible({
    timeout: 10000,
  });

  await page
    .getByPlaceholder(/rechercher|search|clusters\.search\.placeholder/i)
    .fill("EU");

  await expect(page.getByTestId("cluster-row-c1")).toBeVisible();
  await expect(
    page.getByTestId("cluster-row-default-cluster"),
  ).not.toBeVisible();
  await expect(page.getByTestId("cluster-row-c2")).not.toBeVisible();

  await page
    .getByPlaceholder(/rechercher|search|clusters\.search\.placeholder/i)
    .fill("inexistant-xyz");

  await expect(
    page.getByText(
      /aucun cluster ne correspond|no cluster matches|clusters\.search\.noResults/i,
    ),
  ).toBeVisible({ timeout: 10000 });
});

test("le cluster par défaut n'a jamais d'action de suppression", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters");

  await expect(page.getByTestId("cluster-row-default-cluster")).toBeVisible({
    timeout: 10000,
  });

  await expect(
    page.getByTestId("cluster-delete-trigger-default-cluster"),
  ).toHaveCount(0);
  await expect(page.getByTestId("cluster-delete-trigger-c1")).toHaveCount(0);
  await expect(page.getByTestId("cluster-delete-trigger-c2")).toBeVisible();
});

test("navigue vers le détail d'un cluster et affiche le quorum", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters");

  await expect(page.getByTestId("cluster-row-c1")).toBeVisible({
    timeout: 10000,
  });
  await page.getByTestId("cluster-row-c1").click();

  await expect(page).toHaveURL(/\/clusters\/c1$/);
  await expect(
    page.getByRole("heading", { name: /^Cluster EU-2$/i }),
  ).toBeVisible();

  await expect(page.getByText(/manager.*joignable|reachable/i)).toBeVisible();
  await expect(page.getByText(/quorum OK/i)).toBeVisible();
});

test("cluster introuvable affiche une page 404 conviviale", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters/id-inexistant");

  await expect(
    page.getByRole("heading", { name: /introuvable|not found/i }),
  ).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: /retour|back/i }).click();
  await expect(page).toHaveURL(/\/clusters$/);
});

test("ajouter un serveur : toggle manager verrouillé si aucun manager actif", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters/c2");

  await expect(
    page.getByRole("heading", { name: /^Cluster Test$/i }),
  ).toBeVisible({ timeout: 10000 });

  await page
    .getByRole("button", { name: /ajouter un serveur|add a server/i })
    .click();

  await expect(
    page.getByRole("heading", {
      name: /ajouter un serveur à ce cluster|add a server/i,
    }),
  ).toBeVisible();

  const toggle = page.getByRole("switch");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByText(/doit rejoindre comme manager|must join as manager/i),
  ).toBeVisible();
});

test("ajouter un serveur : toggle libre si un manager actif existe déjà", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/clusters/c1");

  await expect(
    page.getByRole("heading", { name: /^Cluster EU-2$/i }),
  ).toBeVisible({ timeout: 10000 });

  await page
    .getByRole("button", { name: /ajouter un serveur|add a server/i })
    .click();

  const toggle = page.getByRole("switch");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
});

test("supprime un cluster sans serveur rattaché : suppression immédiate", async ({
  page,
}) => {
  await stubApi(page, {
    "GET /api/servers": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          servers: [],
          swarmNodes: 0,
          managers: { total: 0, reachable: 0, quorumOk: true },
        }),
      }),
    "DELETE /api/clusters/c2": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          removedServers: 0,
          status: "deleted",
        }),
      }),
  });

  await page.goto("/clusters");

  // On attend que la liste des clusters soit rendue (elle l'est toujours,
  // même si le tableau 'servers' est vide, car 'CLUSTERS' contient 3 éléments).
  await expect(page.getByTestId("cluster-row-default-cluster")).toBeVisible({
    timeout: 10000,
  });

  await page
    .getByTestId("cluster-delete-trigger-c2")
    .getByRole("button")
    .click();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: /supprimer|delete/i }).click();

  await expect(
    page.getByRole("heading", {
      name: /supprimer ce cluster|delete this cluster/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/retirer aussi les|remove the/i),
  ).not.toBeVisible();

  await page
    .getByRole("button", { name: /supprimer|delete/i })
    .last()
    .click();
  await expect(page.getByText(/cluster supprimé|cluster deleted/i)).toBeVisible(
    { timeout: 15000 },
  );
});

test("supprime un cluster avec serveurs : le teardown doit être confirmé explicitement", async ({
  page,
}) => {
  await stubApi(page, {
    "DELETE /api/clusters/c2": (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          removedServers: 1,
          status: "deleting",
        }),
      }),
  });

  await page.goto("/clusters");

  await expect(page.getByTestId("cluster-row-default-cluster")).toBeVisible({
    timeout: 10000,
  });

  await page
    .getByTestId("cluster-delete-trigger-c2")
    .getByRole("button")
    .click();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: /supprimer|delete/i }).click();

  const confirmBtn = page
    .getByRole("button", { name: /supprimer|delete/i })
    .last();
  await expect(confirmBtn).toBeDisabled();
  await expect(
    page.getByText(/tu dois confirmer le teardown|must confirm teardown/i),
  ).toBeVisible();

  await page.getByRole("switch").click();
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();

  await expect(
    page.getByText(/teardown démarré|teardown started/i),
  ).toBeVisible({ timeout: 15000 });
});
