import { Button, Input, Label, Heading, Text } from "@medusajs/ui"
import { FocusModal } from "@medusajs/ui"
import { ModalForm } from "../../components/ModalForm"
import { useState, useEffect } from "react"

export function RailpackModal({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: { repoUrl?: string; branch?: string }
  onSave: (v: { repoUrl: string; branch?: string }) => void
}) {
  const [repoUrl, setRepoUrl] = useState("")
  const [branch, setBranch] = useState("")

  // Sync local state when `initial` or `open` changes so reopening shows current values
  useEffect(() => {
    if (open) {
      setRepoUrl(initial?.repoUrl ?? "")
      setBranch(initial?.branch ?? "")
    }
  }, [initial, open])

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <FocusModal.Header>
          <Heading>Railpack — Build from repository</Heading>
        </FocusModal.Header>
        <FocusModal.Body>
          <ModalForm
            onSubmit={() => {
              if (!repoUrl.trim()) return
              onSave({ repoUrl: repoUrl.trim(), branch: branch.trim() || undefined })
              onOpenChange(false)
            }}
          >
            <div>
              <Label size="small">Repository URL</Label>
              <Input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
              />
              <Text size="xsmall" className="text-ui-fg-muted mt-1">
                Public repositories only for now. Leave empty technology — will be auto-detected at build time.
              </Text>
            </div>

            <div>
              <Label size="small">Branch / ref (optional)</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="transparent" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </ModalForm>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  )
}
