package online.proappstore.companion

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Three entries copied from the live catalogue.json (2026-11-23, `about` shortened), plus invalid ones. Same fixture as iOS CatalogueTests. */
internal const val CATALOGUE_FIXTURE = """
{"apps":[
 {"id":"meet","name":"Meet","category":"social","icon":"&#128222;","iconBg":"#ecfdf5","description":"Instant 1-on-1 video meetings with push notifications.","about":"Meet is a zero-install video calling app.\n\nDesigned for quick 1-on-1 calls, not large meetings.","appUrl":"https://meet.proappstore.online","type":"connected","proFeatures":["WebRTC video and audio calls","Availability toggle"],"websiteUrl":"https://about-meet.proappstore.online","iconUrl":"https://meet.proappstore.online/app-icon-512.png","socialImageUrl":"https://meet.proappstore.online/app-icon-512.png","cfProject":"proappstore-meet"},
 {"id":"grasskarma","name":"GrassKarma","category":"marketplace","icon":"🌱","iconBg":"#2D7D7D","description":"Hyper-local lawn care — neighbours share a mower, street by street.","about":"Built on the premise that most suburban streets have 3-4 lawnmowers for 20+ houses.","appUrl":"https://grasskarma.proappstore.online","proFeatures":["Karma tracking for contributions"],"iconUrl":"https://evil.example/icon.png","heroImageUrl":"http://grasskarma.proappstore.online/og.png"},
 {"id":"rideshare","name":"Rideshare","category":"transport","icon":"&#128260;","iconBg":"not-a-colour","description":"Recurring rides.","appUrl":"https://rideshare.proappstore.online","iconUrl":"https://rideshare.proappstore.online/icon-512.png","heroImageUrl":"https://proappstore.online/og/rideshare.png"},
 {"id":"Bad Id","name":"Invalid","appUrl":"https://bad.proappstore.online"},
 {"id":"insecure","name":"Insecure","appUrl":"http://insecure.proappstore.online"},
 {"id":"offsite","name":"Offsite","appUrl":"https://evil.example"},
 {"id":"nameless","name":"  ","appUrl":"https://nameless.proappstore.online"},
 {"id":"meet","name":"Duplicate","appUrl":"https://meet.proappstore.online"},
 "not an object"
]}
"""

/** Ported from iOS CatalogueTests.swift and CatalogueStoreTests.swift (#627). */
class CatalogueTest {
    private fun fixture() = Catalogue.parse(CATALOGUE_FIXTURE)!!
    private fun app(id: String, category: String = "productivity", hero: Boolean = false, about: String? = null): CatalogueApp {
        val o = JSONObject().put("id", id).put("name", id.replaceFirstChar { it.uppercase() }).put("category", category).put("appUrl", "https://$id.proappstore.online")
        if (hero) o.put("heroImageUrl", "https://$id.proappstore.online/og-image.png")
        if (about != null) o.put("about", about)
        return CatalogueApp.from(o)!!
    }

    @Test fun invalidEntriesAreSkippedNotFatal() {
        assertEquals(listOf("meet", "grasskarma", "rideshare"), fixture().apps.map { it.id })
        assertNull(Catalogue.parse("not json"))
        assertNull(Catalogue.parse("""{"apps":{}}"""))
    }

    @Test fun emojiFromEntitiesRawEmojiOrInitial() {
        val apps = fixture().apps
        assertEquals("📞", apps[0].glyph)
        assertEquals("🌱", apps[1].glyph)
        assertEquals("❤", CatalogueApp.decodeEntities("&#10084;"))
        assertEquals("📞", CatalogueApp.decodeEntities("&#x1F4DE;"))
        assertEquals("a &#bad; b", CatalogueApp.decodeEntities("a &#bad; b"))
        assertEquals("P", app("planner").glyph)
    }

    @Test fun imageUrlsOnlyFromThePlatform() {
        val apps = fixture().apps
        assertEquals("https://meet.proappstore.online/app-icon-512.png", apps[0].iconUrl)
        assertNull("off-origin", apps[1].iconUrl)
        assertNull("http", apps[1].heroImageUrl)
        assertEquals("the apex is allowed for images", "https://proappstore.online/og/rideshare.png", apps[2].heroImageUrl)
        assertNull("socialImageUrl is never used", apps[0].heroImageUrl)
        assertFalse(CatalogueApp.onPlatform("https://user@x.proappstore.online/", apex = true))
        assertFalse(CatalogueApp.onPlatform("https://x.proappstore.online:8443/", apex = true))
        assertFalse(CatalogueApp.onPlatform("https://proappstore.online.evil.example/", apex = true))
        assertFalse("the apex is not an app", CatalogueApp.onPlatform("https://proappstore.online/", apex = false))
    }

    @Test fun colourFallsBackToTheDefault() {
        assertEquals(0xFF2D7D7DL, CatalogueApp.hexArgb("#2D7D7D"))
        assertEquals(0xFFAABBCCL, CatalogueApp.hexArgb("#abc"))
        assertEquals(0xCC7C3AEDL, CatalogueApp.hexArgb("#7c3aedcc"))
        assertNull(CatalogueApp.hexArgb("not-a-colour")); assertNull(CatalogueApp.hexArgb("#12345"))
        val apps = fixture().apps
        assertEquals(0xFF7C3AEDL, apps[2].tileArgb)
        assertTrue(apps[0].tileIsLight); assertFalse(apps[1].tileIsLight)
    }

    @Test fun categoryDisplayName() {
        assertEquals("Real estate", CatalogueApp.displayName("real-estate"))
        assertEquals("Productivity", CatalogueApp.displayName("productivity"))
        assertEquals("Other", CatalogueApp.displayName(null))
    }

    @Test fun categoriesByCountThenName() {
        val catalogue = Catalogue(listOf(app("a", "travel"), app("b", "sports"), app("c", "business"), app("d", "sports"), app("e", "business"), app("f", "sports")))
        assertEquals(listOf("Sports", "Business", "Travel"), catalogue.categories.map { it.first })
        assertEquals("catalogue order within a row", listOf("b", "d", "f"), catalogue.categories[0].second.map { it.id })
    }

    @Test fun searchCoversAboutAndFeaturesInsensitively() {
        val catalogue = fixture()
        assertEquals("a word only in about", listOf("grasskarma"), catalogue.search("lawnmowers").map { it.id })
        assertEquals("pro features, case-insensitive", listOf("meet"), catalogue.search("  webrtc ").map { it.id })
        assertEquals("diacritics", listOf("cafe"), Catalogue(listOf(app("cafe", about = "Order at the café"))).search("CAFE").map { it.id })
        assertEquals("category", listOf("grasskarma"), catalogue.search("marketplace").map { it.id })
        assertEquals(emptyList<CatalogueApp>(), catalogue.search("zzz"))
        assertEquals(emptyList<CatalogueApp>(), catalogue.search(" "))
    }

    @Test fun featuredWithNoAndWithFourHeroImages() {
        assertEquals(listOf("app1", "app2", "app3", "app4", "app5"), Catalogue((1..7).map { app("app$it") }).featured.map { it.id })
        val four = listOf(app("a"), app("b", hero = true), app("c", hero = true), app("d"), app("e", hero = true), app("f", hero = true))
        assertEquals(listOf("b", "c", "e", "f"), Catalogue(four).featured.map { it.id })
        assertEquals(listOf("b", "a", "c"), Catalogue(listOf(app("a"), app("b", hero = true), app("c"))).featured.map { it.id })
    }

    @Test fun openAddsTheInstallHint() {
        assertEquals("https://meet.proappstore.online/?install=1", fixture().apps[0].openUrl)
        val deep = CatalogueApp.from(JSONObject().put("id", "x").put("name", "X").put("appUrl", "https://x.proappstore.online/start?ref=store"))!!
        assertEquals("https://x.proappstore.online/start?ref=store&install=1", deep.openUrl)
    }

    // CatalogueStore: cache first, revalidate with If-None-Match, keep the cache on anything but a good 200.

    private class FakeFetch(var reply: (Map<String, String>) -> PublicFetch.Result) : PublicFetch() {
        val requests = mutableListOf<Pair<String, Map<String, String>>>()
        override fun get(url: String, headers: Map<String, String>, maxBytes: Int): PublicFetch.Result { requests += url to headers; return reply(headers) }
    }
    private fun ok(body: String, etag: String? = "\"v1\"") = PublicFetch.Result(200, body.toByteArray(), etag)

    @Test fun storePublishesTheCacheBeforeAnyRequestAndRevalidates() = runBlocking {
        val dir = Files.createTempDirectory("catalogue").toFile()
        val fetch = FakeFetch { ok(CATALOGUE_FIXTURE) }
        val first = CatalogueStore(dir, fetch)
        assertTrue(first.state.value.catalogue.apps.isEmpty())
        first.refresh()
        assertEquals(CatalogueStore.URL, fetch.requests.single().first)
        assertTrue("no validator on a cold start", fetch.requests.single().second.isEmpty())
        assertEquals(3, first.state.value.catalogue.apps.size)

        val second = CatalogueStore(dir, fetch)
        assertEquals("cached file published before any network call", 3, second.state.value.catalogue.apps.size)
        fetch.reply = { PublicFetch.Result(304, ByteArray(0), null) }
        second.refresh()
        assertEquals(mapOf("If-None-Match" to "\"v1\""), fetch.requests.last().second)
        assertEquals(3, second.state.value.catalogue.apps.size)
        assertFalse(second.state.value.stale)
        assertTrue("no Authorization or Cookie ever", fetch.requests.all { (_, h) -> h.keys.none { it.equals("Authorization", true) || it.equals("Cookie", true) } })
    }

    @Test fun storeKeepsTheCacheOnAMalformedEmptyOrFailedReply() = runBlocking {
        val dir = Files.createTempDirectory("catalogue").toFile()
        val fetch = FakeFetch { ok(CATALOGUE_FIXTURE) }
        val store = CatalogueStore(dir, fetch)
        store.refresh()
        for (reply in listOf(ok("<html>"), ok("""{"apps":[]}"""), PublicFetch.Result(500, ByteArray(0), null), PublicFetch.Result(301, ByteArray(0), null))) {
            fetch.reply = { reply }
            store.refresh()
            assertTrue(store.state.value.stale)
            assertEquals(3, store.state.value.catalogue.apps.size)
        }
        fetch.reply = { throw java.io.IOException("offline") }
        store.refresh()
        assertTrue(store.state.value.stale)
        assertEquals(3, CatalogueStore(dir, fetch).state.value.catalogue.apps.size)
        // A good 200 replaces it.
        fetch.reply = { ok("""{"apps":[{"id":"solo","name":"Solo","appUrl":"https://solo.proappstore.online"}]}""", null) }
        store.refresh()
        assertFalse(store.state.value.stale)
        assertEquals(listOf("solo"), store.state.value.catalogue.apps.map { it.id })
        assertFalse("no stale validator kept", File(dir, "catalogue.etag").exists())
    }
}
