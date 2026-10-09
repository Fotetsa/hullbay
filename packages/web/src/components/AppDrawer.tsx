import { Button, Drawer } from "@medusajs/ui"
import type { ReactNode } from "react"

type AppDrawerProps = {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  onSave?: () => void | Promise<void>
  saveLabel?: string
  isLoading?: boolean
  saveDisabled?: boolean
}

export function AppDrawer({
  isOpen,
  onClose,
  title,
  description,
  children,
  onSave,
  saveLabel = "Enregistrer",
  isLoading = false,
  saveDisabled = false,
}: AppDrawerProps) {
  return (
    <Drawer
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Drawer.Content className="sm:max-w-[560px]">
        <Drawer.Header>
          <div className="flex flex-col gap-1">
            <Drawer.Title className="text-lg font-semibold text-ui-fg-base">{title}</Drawer.Title>
            {description ? (
              <Drawer.Description className="text-sm text-ui-fg-subtle">
                {description}
              </Drawer.Description>
            ) : null}
          </div>
        </Drawer.Header>

        <Drawer.Body className="px-6 py-4">{children}</Drawer.Body>

        <Drawer.Footer className="justify-between sm:justify-end">
          <Button variant="secondary" onClick={onClose} type="button">
            Annuler
          </Button>

          {onSave ? (
            <Button
              onClick={() => void onSave()}
              isLoading={isLoading}
              disabled={saveDisabled || isLoading}
              type="button"
            >
              {saveLabel}
            </Button>
          ) : null}
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}
