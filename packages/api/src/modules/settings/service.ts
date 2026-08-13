import { prisma } from "../../lib/prisma"
import { applyDomainToCaddy } from "./caddy-domain"

const SINGLETON_ID = "singleton"
export class SettingsService {
    /**Lit les parametres. Renvoie domain: null si rien n'a ete configure */
    async get() {
        const Settings = await prisma.settings.upsert({
            where: { id: SINGLETON_ID },
            create: { id: SINGLETON_ID },
            update: {},
        })
        return { domain: Settings.domain }
    }

    /**
     * Definition ou bien remplacement du nom de domaine
     * 
     * on applique d'abord la config a caddy, et on ne persiste en DB que si caddy a accepte.
     */
    async setDomain(domain: string) {
        await applyDomainToCaddy(domain)

        const Settings = await prisma.settings.upsert({
            where: { id: SINGLETON_ID },
            create: { id: SINGLETON_ID, domain },
            update: { domain },
        })

        return { 
            domain: Settings.domain,
            url: `https://${Settings.domain}`
        }
    }
}

export const settingsService = new SettingsService()