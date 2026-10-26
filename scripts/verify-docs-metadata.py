"""Check actual public documentation HTML before uploading it to the KB host."""
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.descriptions = []
        self.canonicals = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name") == "description":
            self.descriptions.append(attrs.get("content", ""))
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonicals.append(attrs.get("href"))


def verify(site):
    urls = [el.text for el in ET.parse(site / "sitemap.xml").iter()
            if el.tag.endswith("}loc")]
    assert urls, "Documentation sitemap is empty"
    descriptions = {}
    pages = {"https://docs.proappstore.online/" + str(page.relative_to(site)).removesuffix("index.html"): page
             for page in site.rglob("index.html")}
    assert set(urls) <= pages.keys(), "A sitemap URL has no generated page"
    for url, page in pages.items():
        parsed = urlsplit(url)
        assert parsed.scheme == "https" and parsed.netloc == "docs.proappstore.online", url
        metadata = Metadata()
        metadata.feed(page.read_text(encoding="utf-8"))
        assert metadata.canonicals == [url], (url, metadata.canonicals)
        assert len(metadata.descriptions) == 1 and metadata.descriptions[0].strip(), (url, metadata.descriptions)
        description = metadata.descriptions[0]
        assert description not in descriptions, (url, "Duplicate description", descriptions.get(description))
        descriptions[description] = url
    print(f"Verified {len(pages)} public docs pages: distinct descriptions and unchanged self-canonicals")


if __name__ == "__main__":
    verify(Path(sys.argv[1] if len(sys.argv) > 1 else "site"))
