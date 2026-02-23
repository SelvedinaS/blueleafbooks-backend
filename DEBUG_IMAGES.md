# Dijagnostika: Zašto se slika ne prikazuje

## Mogući uzroci

### 1. **Pogrešan URL u bazi (MongoDB)**
- **Provjeri:** Otvori MongoDB, pronađi knjigu, pogledaj polje `coverImage`
- **Očekivano:** Pun URL tipa `https://blueleafbooks.fra1.digitaloceanspaces.com/covers/1234567890-123.jpg`
- **Problem ako vidiš:** `uploads/covers/...` (lokalni path – na Renderu ne postoji) ili `blueleafbooks/covers/...` (samo path bez domene)

### 2. **Backend vraća pogrešan URL**
- **Provjeri:** Otvori u browseru: `https://blueleafbooks-backend-geum.onrender.com/api/books`
- Pogledaj JSON – svaka knjiga treba imati `coverImage` s punim URL-om
- Ako je Spaces: trebao bi biti `https://...onrender.com/api/proxy-image?url=...`

### 3. **Proxy ne može dohvatiti sliku**
- **Provjeri:** Kopiraj `coverImage` URL iz API odgovora, otvori ga u novom tabu
- Ako vidiš JSON `{"message":"Failed to fetch image"}` → proxy ne može dohvatiti s Spacesa
- **Uzrok:** Slika ne postoji na tom URL-u (404), ili Spaces vraća 403 (pristup odbijen)

### 4. **Frontend koristi pogrešan API URL**
- **Provjeri:** U `js/api.js` je `API_BASE_URL` isti kao tvoj backend (Render URL)
- Ako je frontend na drugom domenu (npr. Netlify), mora koristiti puni backend URL

### 5. **Stare knjige – pogrešan path**
- Knjige uploadane prije fixa mogu imati key `blueleafbooks/covers/xxx.jpg` u Spacesu
- Novi key je `covers/xxx.jpg` (bez prefiksa)
- **Rješenje:** Autor treba Edit knjige → ponovno uploadati naslovnicu

### 6. **Spaces bucket nije public**
- U DigitalOcean dashboardu: Space → Settings → File Listing mora biti **Public**
- Ili: svaki objekt mora imati ACL `public-read` (to smo dodali u kodu)

---

## Hoće li problem sa slikom utjecati na skidanje PDF-a?

**Ne.** Slika (coverImage) i PDF (pdfFile) su odvojeni:
- **coverImage** = naslovnica za prikaz
- **pdfFile** = PDF za preuzimanje

PDF se skida iz `pdfFile` polja. Ako je `pdfFile` ispravan u bazi (pun Spaces URL), skidanje će raditi neovisno o tome prikazuje li se slika ili ne.

---

## Brza provjera

1. Otvori: `https://blueleafbooks-backend-geum.onrender.com/api/books`
2. Pronađi prvu knjigu, kopiraj `coverImage` vrijednost
3. Otvori taj URL u novom tabu:
   - Ako vidiš sliku → problem je na frontendu (cache, API_BASE_URL)
   - Ako vidiš JSON error → problem je na backendu ili Spacesu
   - Ako vidiš 404 → slika ne postoji na tom pathu u Spacesu
