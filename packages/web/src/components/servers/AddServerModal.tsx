import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, FocusModal, Heading, Input, Label, RadioGroup, Text, Textarea, Switch } from "@medusajs/ui"
import { api } from "../../lib/api"
import { useMutationToast } from "../../lib/useMutationToast"
import { useProvisionLog } from "../../lib/useProvisionLog"
import { isValidHostnameOrIp, isValidPort } from "../../lib/validation"
import { ModalForm } from "../ModalForm"

export function AddServerModal({
  open,
  onOpenChange,
  clusterId,
  forceManager,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clusterId: string
  /** true = aucun manager actif dans ce cluster — le toggle est verrouillé
   * sur "manager", impossible de rejoindre comme worker (pas de Swarm à
   * joindre sans manager vivant pour délivrer un token). */
  forceManager: boolean
}) {
  const { t } = useTranslation()
  const { lines, clear } = useProvisionLog(open)

  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState(22)
  const [user, setUser] = useState("root")
  const [credType, setCredType] = useState<"key" | "password">("key")
  const [privateKey, setPrivateKey] = useState("")
  const [password, setPassword] = useState("")
  const [asManager, setAsManager] = useState(forceManager)

  const hostError = host && !isValidHostnameOrIp(host) ? t("clusters.createModal.errors.host") : null
  const portError = !isValidPort(port) ? t("clusters.createModal.errors.port") : null

  const provision = useMutationToast({
    mutationFn: () =>
      api.provisionServer({
        name, host, port, user, clusterId,
        role: forceManager || asManager ? "manager" : "worker",
        credential: credType === "key" ? { type: "key", privateKey } : { type: "password", password },
      }),
    success: t("clusters.detail.addServer.toast.started"),
    invalidate: [["servers"], ["clusters"], ["health"]],
    onSuccess: () => { setPrivateKey(""); setPassword("") },
  })

  const canSubmit =
    Boolean(name.trim()) && isValidHostnameOrIp(host) && isValidPort(port) &&
    (credType === "key" ? Boolean(privateKey) : Boolean(password))

  return (
    <FocusModal
      open={open}
      onOpenChange={(o) => { onOpenChange(o); if (o) { clear(); setAsManager(forceManager) } }}
    >
      <FocusModal.Content>
        <FocusModal.Header><Heading>{t("clusters.detail.addServer.title")}</Heading></FocusModal.Header>
        <FocusModal.Body className="overflow-y-auto">
          <ModalForm size="lg" onSubmit={(e?: React.FormEvent) => { e?.preventDefault?.(); if (canSubmit) provision.mutate() }}>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label size="small">{t("clusters.createModal.serverNameLabel")}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="worker-2" />
              </div>
              <div>
                <Label size="small">{t("clusters.createModal.hostLabel")}</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.11" />
                {hostError && <Text size="xsmall" className="mt-1 text-ui-fg-error">{hostError}</Text>}
              </div>
              <div>
                <Label size="small">{t("clusters.createModal.portLabel")}</Label>
                <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
                {portError && <Text size="xsmall" className="mt-1 text-ui-fg-error">{portError}</Text>}
              </div>
              <div>
                <Label size="small">{t("clusters.createModal.userLabel")}</Label>
                <Input value={user} onChange={(e) => setUser(e.target.value)} />
              </div>
            </div>
            <div>
              <Label size="small">{t("clusters.createModal.authMethodLabel")}</Label>
              <RadioGroup value={credType} onValueChange={(v) => setCredType(v as "key" | "password")}>
                <div className="flex items-center gap-2">
                  <RadioGroup.Item value="key" id="as-key" />
                  <Label htmlFor="as-key">{t("clusters.createModal.sshKey")}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroup.Item value="password" id="as-pw" />
                  <Label htmlFor="as-pw">{t("clusters.createModal.password")}</Label>
                </div>
              </RadioGroup>
            </div>
            {credType === "key" ? (
              <Textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={5} />
            ) : (
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}

            {/* Toggle verrouillé si aucun manager actif */}
            <div className="flex items-center justify-between rounded-lg border border-ui-border-base p-3">
              <div>
                <Label size="small">{t("clusters.detail.addServer.managerLabel")}</Label>
                <Text size="xsmall" className="text-ui-fg-muted">
                  {forceManager
                    ? t("clusters.detail.addServer.managerForcedHint")
                    : t("clusters.detail.addServer.managerOptionalHint")}
                </Text>
              </div>
              <Switch checked={forceManager || asManager} disabled={forceManager} onCheckedChange={setAsManager} />
            </div>

            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
              <Button type="submit" isLoading={provision.isPending} disabled={!canSubmit}>{t("clusters.actions.create")}</Button>
            </div>
            {lines.length > 0 && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-ui-bg-base-pressed p-2 txt-compact-xsmall font-mono text-ui-fg-subtle" aria-live="polite">
                {lines.map((l) => l.message).join("\n")}
              </pre>
            )}
          </ModalForm>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  )
}