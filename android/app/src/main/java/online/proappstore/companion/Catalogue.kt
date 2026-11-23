package online.proappstore.companion

import java.net.URI
import java.text.Collator
import java.text.Normalizer
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/**
 * One app from the public `https://proappstore.online/catalogue.json` (ADR-017, #627). Validated with the storefront's
 * own rules (`proappstore/build.js`); `Catalogue.parse` skips an invalid entry instead of failing the file.
 */
data class CatalogueApp(
    val id: String, val name: String, val category: String?, val icon: String?, val iconBg: String?,
    val description: String?, val about: String?, val appUrl: String, val proFeatures: List<String>,
    val iconUrl: String?, val heroImageUrl: String?, val websiteUrl: String?,
) {
    /** The emoji drawn on `iconBg`: HTML numeric entities decoded, else the name's first letter. */
    val glyph: String get() = decodeEntities(icon ?: "").trim().ifEmpty { name.take(1).uppercase() }
    /** `iconBg` as ARGB; the storefront default `#7c3aed` when absent or invalid. */
    val tileArgb: Long get() = hexArgb(iconBg) ?: hexArgb(DEFAULT_TILE)!!
    /** Text over the tile: dark on light pastels (`#ecfdf5`), white on the rest. */
    val tileIsLight: Boolean get() = luminance(tileArgb) > 0.6
    val categoryName: String get() = displayName(category)
    /** Open from the companion: the app with the install hint (#628), which the host turns into an Install button. */
    val openUrl: String get() = URI(appUrl).let { u ->
        URI(u.scheme, u.authority, u.path?.ifEmpty { "/" } ?: "/", listOfNotNull(u.query, "install=1").joinToString("&"), u.fragment).toString()
    }

    fun matches(query: String): Boolean {
        val q = fold(query)
        return (listOfNotNull(name, description, categoryName, about) + proFeatures).any { fold(it).contains(q) }
    }

    companion object {
        const val DEFAULT_TILE = "#7c3aed"
        private val ID = Regex("^[a-z0-9][a-z0-9-]*$")
        private val COLOR = Regex("^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

        /** Null when the entry is invalid. Unknown keys are ignored; `socialImageUrl` is never used (it can be the store logo). */
        fun from(o: JSONObject): CatalogueApp? {
            fun text(key: String): String? = (o.opt(key) as? String)?.trim()?.ifEmpty { null }
            val id = o.opt("id") as? String ?: return null
            val name = text("name") ?: return null
            val appUrl = text("appUrl")?.takeIf { onPlatform(it, apex = false) } ?: return null
            if (!ID.matches(id)) return null
            val features = (o.opt("proFeatures") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.ifBlank { null } } }
            return CatalogueApp(
                id, name, text("category"), text("icon"), text("iconBg"), text("description"), text("about"), appUrl, features ?: emptyList(),
                text("iconUrl")?.takeIf { onPlatform(it, apex = true) }, text("heroImageUrl")?.takeIf { onPlatform(it, apex = true) },
                text("websiteUrl")?.takeIf { url -> runCatching { URI(url).let { it.scheme == "https" && !it.host.isNullOrEmpty() } }.getOrDefault(false) },
            )
        }

        /** `https` on `*.proappstore.online` (and the apex itself when `apex`): `URL_RE` in build.js, `isAllowedIconUrl` for images. */
        fun onPlatform(url: String, apex: Boolean): Boolean = runCatching {
            val u = URI(url)
            val host = u.host?.lowercase() ?: return false
            u.scheme == "https" && u.rawUserInfo == null && u.port == -1 && (host.endsWith(".proappstore.online") || (apex && host == "proappstore.online"))
        }.getOrDefault(false)

        /** `"real-estate"` → `"Real estate"`. */
        fun displayName(category: String?): String = (category ?: "other").replace("-", " ").replaceFirstChar { it.uppercase() }

        /** `&#128222;` and `&#x1F4DE;` to characters; everything else is kept as is. */
        fun decodeEntities(text: String): String = Regex("&#([xX][0-9a-fA-F]+|[0-9]+);").replace(text) { m ->
            val body = m.groupValues[1]
            val code = if (body[0] == 'x' || body[0] == 'X') body.drop(1).toIntOrNull(16) else body.toIntOrNull()
            if (code != null && Character.isValidCodePoint(code)) String(Character.toChars(code)) else m.value
        }

        /** CSS `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (`COLOR_RE` in build.js) as ARGB, or null. */
        fun hexArgb(hex: String?): Long? {
            if (hex == null || !COLOR.matches(hex)) return null
            var digits = hex.drop(1)
            if (digits.length <= 4) digits = digits.map { "$it$it" }.joinToString("")
            if (digits.length == 6) digits += "ff"
            val rgba = digits.toLong(16)
            return ((rgba and 0xff) shl 24) or (rgba ushr 8)
        }

        fun luminance(argb: Long): Double {
            fun channel(shift: Int) = ((argb shr shift) and 0xff) / 255.0
            return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }

        private fun fold(text: String): String =
            Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)
    }
}

/** The decoded file. Entries are validated one by one, so a bad entry drops only itself. */
data class Catalogue(val apps: List<CatalogueApp>) {
    /** Up to 5: apps with a hero image, in catalogue order; with fewer than 3, the first other apps fill the banner. */
    val featured: List<CatalogueApp> get() {
        val heroes = apps.filter { it.heroImageUrl != null }.take(5)
        return if (heroes.size >= 3) heroes else heroes + apps.filter { it.heroImageUrl == null }.take(5 - heroes.size)
    }
    /** One row per category, by app count (descending) then name; catalogue order within a row. */
    val categories: List<Pair<String, List<CatalogueApp>>> get() = apps.groupBy { it.categoryName }.toList()
        .sortedWith(compareByDescending<Pair<String, List<CatalogueApp>>> { it.second.size }.thenComparator { a, b -> collator.compare(a.first, b.first) })
    val byName: List<CatalogueApp> get() = apps.sortedWith { a, b -> collator.compare(a.name, b.name) }

    fun search(query: String): List<CatalogueApp> = query.trim().let { q -> if (q.isEmpty()) emptyList() else byName.filter { it.matches(q) } }

    companion object {
        private val collator: Collator = Collator.getInstance().apply { strength = Collator.SECONDARY }
        /** Null when the body is not a catalogue at all. */
        fun parse(json: String): Catalogue? = runCatching {
            val list = JSONObject(json).getJSONArray("apps")
            val seen = mutableSetOf<String>()
            Catalogue((0 until list.length()).mapNotNull { i -> (list.opt(i) as? JSONObject)?.let(CatalogueApp::from) }.filter { seen.add(it.id) })
        }.getOrNull()
    }
}
