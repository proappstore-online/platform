package online.proappstore.companion

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Everything the Store tab needs from the activity. */
class StoreHooks(
    val state: CatalogueStore.State = CatalogueStore.State(),
    val images: ImageCache? = null,
    val refresh: () -> Unit = {},
    /** Every Open goes through here: the app with `?install=1` (#628). */
    val open: (CatalogueApp) -> Unit = {},
    val openUrl: (String) -> Unit = {},
)

internal val CatalogueApp.tileColor: Color get() = Color(tileArgb.toInt())

/** The native, browse-only storefront (ADR-017, #627): featured, Yours, categories and All apps, or search results. */
@Composable
internal fun StoreScreen(companion: CompanionState, store: StoreHooks, showApp: (CatalogueApp) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val catalogue = store.state.catalogue
    val enabledIds = companion.apps.filter { companion.enabled(it) }.map { it.id }.toSet()
    val yours = if (companion.signedIn) catalogue.apps.filter { it.id in enabledIds } else emptyList()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Store", style = MaterialTheme.typography.headlineLarge)
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("Apps, categories and features") },
                    trailingIcon = { if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("Clear") } })
                if (store.state.stale && catalogue.apps.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Showing the last downloaded copy.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    TextButton(onClick = store.refresh, enabled = !store.state.loading) { Text("Retry") }
                }
            }
        }
        when {
            catalogue.apps.isEmpty() -> item {
                Column(Modifier.fillMaxWidth().padding(top = 60.dp, start = 24.dp, end = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (store.state.loading) CircularProgressIndicator()
                    else {
                        Text("Connect to the internet to load the store", style = MaterialTheme.typography.titleMedium)
                        Text("The store works offline once it has loaded.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = store.refresh) { Text("Retry") }
                    }
                }
            }
            query.isNotBlank() -> {
                val found = catalogue.search(query)
                if (found.isEmpty()) item { Text("No apps match “${query.trim()}”", Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium) }
                items(found, key = { "s-" + it.id }) { AppListRow(it, store, showApp) }
            }
            else -> {
                item { Featured(catalogue.featured, store, showApp) }
                if (yours.isNotEmpty()) item { Shelf("Yours", yours, store, showApp) }
                catalogue.categories.forEach { (name, apps) -> item(key = "c-$name") { Shelf(name, apps, store, showApp) } }
                item { SectionHeader("All apps", "${catalogue.apps.size}") }
                items(catalogue.byName, key = { "a-" + it.id }) { AppListRow(it, store, showApp) }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, detail: String?) {
    Row(Modifier.padding(horizontal = 16.dp).semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.Bottom) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        if (detail != null) Text("  $detail", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Paged cards, no autoplay. A card has the hero image, or is drawn on `iconBg` when the app has none. */
@Composable
private fun Featured(apps: List<CatalogueApp>, store: StoreHooks, showApp: (CatalogueApp) -> Unit) {
    if (apps.isEmpty()) return
    val pager = rememberPagerState { apps.size }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalPager(pager, contentPadding = PaddingValues(horizontal = 16.dp), pageSpacing = 12.dp) { page ->
            val app = apps[page]
            val shape = RoundedCornerShape(20.dp)
            Box(Modifier.fillMaxWidth().aspectRatio(1.6f).clip(shape).background(Brush.verticalGradient(listOf(app.tileColor, app.tileColor.copy(alpha = 0.8f))))
                .clickable(onClickLabel = "Show ${app.name}") { showApp(app) }
                .semantics(mergeDescendants = true) { contentDescription = "Featured: ${app.name}" }) {
                val hero = app.heroImageUrl
                if (hero != null) {
                    RemoteImage(hero, store.images, Modifier.fillMaxSize())
                    Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f)))).padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        AppIcon(app, 48.dp, store.images)
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text(app.name, color = Color.White, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                            Text(app.description ?: app.categoryName, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodySmall, maxLines = 2)
                        }
                    }
                } else {
                    val ink = if (app.tileIsLight) Color.Black else Color.White
                    Column(Modifier.fillMaxSize().padding(18.dp)) {
                        Text(app.categoryName.uppercase(), color = ink.copy(alpha = 0.7f), style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.weight(1f))
                        Row(verticalAlignment = Alignment.Bottom) {
                            AppIcon(app, 96.dp, store.images)
                            Spacer(Modifier.width(16.dp))
                            Column {
                                Text(app.name, color = ink, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(app.description ?: "", color = ink.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().clearAndSetSemantics {}, horizontalArrangement = Arrangement.Center) {
            repeat(apps.size) { i ->
                Box(Modifier.padding(3.dp).size(7.dp).background(if (i == pager.currentPage) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape))
            }
        }
    }
}

/** A shelf: 64 dp icon, name, and one line of description. */
@Composable
private fun Shelf(title: String, apps: List<CatalogueApp>, store: StoreHooks, showApp: (CatalogueApp) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionHeader(title, if (apps.size > 1) "${apps.size}" else null)
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(apps, key = { it.id }) { app ->
                Column(Modifier.width(132.dp).clickable(onClickLabel = "Show ${app.name}") { showApp(app) }.semantics(mergeDescendants = true) {},
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    AppIcon(app, 64.dp, store.images)
                    Text(app.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(app.description ?: app.categoryName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** An All apps / search row: 48 dp icon, name, category, and Open. */
@Composable
private fun AppListRow(app: CatalogueApp, store: StoreHooks, showApp: (CatalogueApp) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable(onClickLabel = "Show ${app.name}") { showApp(app) }.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
            AppIcon(app, 48.dp, store.images)
            Spacer(Modifier.width(12.dp))
            Column {
                Text(app.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                Text(app.categoryName, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        OpenButton(app, prominent = false, store.open)
    }
}

@Composable
private fun OpenButton(app: CatalogueApp, prominent: Boolean, open: (CatalogueApp) -> Unit) {
    val label = Modifier.semantics { contentDescription = "Open ${app.name}" }
    if (prominent) Button(onClick = { open(app) }, modifier = label) { Text("Open") }
    else FilledTonalButton(onClick = { open(app) }, modifier = label) { Text("Open") }
}

/** One app's page: hero, header with Open, the companion toggle for reviewed recipients, description, About, Pro features, website. */
@Composable
internal fun StoreAppScreen(
    app: CatalogueApp, companion: CompanionState, store: StoreHooks, connect: () -> Unit,
    askConsent: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit, back: () -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        BackRow("Store", back)
        val shape = RoundedCornerShape(16.dp)
        val hero = app.heroImageUrl
        // The hero image at 1.91:1, or an `iconBg` band. Never the icon scaled up.
        if (hero != null) Box(Modifier.fillMaxWidth().aspectRatio(1.91f).clip(shape).background(app.tileColor)) { RemoteImage(hero, store.images, Modifier.fillMaxSize()) }
        else Box(Modifier.fillMaxWidth().height(88.dp).clip(shape).background(Brush.verticalGradient(listOf(app.tileColor, app.tileColor.copy(alpha = 0.75f)))))
        Row(verticalAlignment = Alignment.CenterVertically) {
            AppIcon(app, 96.dp, store.images)
            Spacer(Modifier.width(16.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(app.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(app.categoryName, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OpenButton(app, prominent = true, store.open)
            }
        }
        companion.apps.find { it.id == app.id }?.let { connected -> CompanionToggle(connected, companion, connect, askConsent, disable) }
        app.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
        app.about?.let { about ->
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("About", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
                about.split("\n\n").map { it.trim() }.filter { it.isNotEmpty() }.forEach { Text(it) }
            }
        }
        if (app.proFeatures.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Pro features", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
            app.proFeatures.forEach { Row { Text("✓  ", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold); Text(it) } }
        }
        app.websiteUrl?.let { url -> OutlinedButton(onClick = { store.openUrl(url) }) { Text("Website") } }
        Spacer(Modifier.height(24.dp))
    }
}

/** The toggle only asks: on opens the existing disclosure, whose button alone enables. Off turns sharing off. */
@Composable
private fun CompanionToggle(connected: ConnectedApp, companion: CompanionState, connect: () -> Unit, askConsent: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (companion.signedIn) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Use with companion", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Switch(checked = companion.enabled(connected), enabled = !companion.busy,
                    onCheckedChange = { on -> if (on) askConsent(connected) else disable(connected) },
                    modifier = Modifier.semantics { contentDescription = "Use ${connected.name} with companion" })
            } else {
                Text("Use with companion", style = MaterialTheme.typography.titleMedium)
                OutlinedButton(onClick = connect, enabled = !companion.busy) { Text("Sign in to use with ProAppStore") }
            }
            Text("Background location: ${connected.purpose}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (connected.id in companion.blocked) Text("Disabled on this phone. Server revocation will finish when connected.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** The app icon: the catalogue image when there is one, always over the emoji tile on `iconBg`. */
@Composable
internal fun AppIcon(app: CatalogueApp, size: Dp, images: ImageCache?) {
    val shape = RoundedCornerShape(size * 0.22f)
    Box(Modifier.size(size).clip(shape).background(app.tileColor).border(0.5.dp, Color.Black.copy(alpha = 0.08f), shape).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Text(app.glyph, fontSize = with(LocalDensity.current) { (size * 0.5f).toSp() }, maxLines = 1, color = if (app.tileIsLight) Color.Black else Color.White)
        app.iconUrl?.let { RemoteImage(it, images, Modifier.fillMaxSize()) }
    }
}

/** A remote image over whatever is behind it: nothing shows while loading, offline or after a failure. */
@Composable
internal fun RemoteImage(url: String, images: ImageCache?, modifier: Modifier) {
    val bitmap by produceState<Bitmap?>(images?.cached(url), url, images) { if (value == null) value = images?.image(url) }
    bitmap?.let { Image(it.asImageBitmap(), contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop) }
}
