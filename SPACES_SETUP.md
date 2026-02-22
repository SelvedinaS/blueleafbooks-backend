# DigitalOcean Spaces – postavljanje za slike knjiga

**Na Renderu se datoteke ne čuvaju između restarta.** Slike i PDF-ovi uploadani na lokalni disk nestaju kad se server restartuje.

## Rješenje: DigitalOcean Spaces

1. Kreiraj Space na [DigitalOcean](https://cloud.digitalocean.com/spaces)
2. Postavi bucket na **Public** (Settings → File Listing: Public)
3. Kreiraj API ključ (API → Spaces Keys)
4. U Renderu dodaj Environment Variables:

| Variable | Value |
|----------|-------|
| `SPACES_BUCKET` ili `DO_SPACES_BUCKET` | ime tvog Space-a |
| `SPACES_KEY` ili `DO_SPACES_KEY` | Access Key |
| `SPACES_SECRET` ili `DO_SPACES_SECRET` | Secret Key |
| `SPACES_REGION` ili `DO_SPACES_REGION` | npr. `nyc3` ili `fra1` |
| `DO_SPACES_PUBLIC_BASE_URL` | **VAŽNO** – npr. `https://blueleafbooks.fra1.digitaloceanspaces.com` |

5. Redeploy backend

Nakon toga nove slike će se spremati u Spaces i bit će trajno dostupne.

**Postojeće knjige:** Autor treba Edit → ponovno uploadati naslovnicu.
