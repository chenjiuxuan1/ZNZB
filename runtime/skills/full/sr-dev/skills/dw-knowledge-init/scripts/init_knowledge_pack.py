#!/usr/bin/env python3
import argparse
import hashlib
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


SUPPORTED_SUFFIXES = {".md", ".txt"}


def slugify(value):
    text = str(value or "").strip().lower()
    text = re.sub(r"\.[^.]+$", "", text)
    text = re.sub(r"^[0-9]+[-_ ]*", "", text)
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text)
    text = text.strip("-")
    return text or "doc"


def yaml_quote(value):
    text = str(value or "")
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def title_for(path):
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return Path(path).stem


def discover_source_files(source_dir):
    root = Path(source_dir)
    files = [
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES and not path.name.startswith(".")
    ]
    return sorted(files)


def read_existing_versions(index_path):
    versions = {}
    if not Path(index_path).is_file():
        return versions
    current_path = None
    current_hash = None
    current_version = None
    for raw_line in Path(index_path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("- id:"):
            if current_path and current_hash and current_version:
                versions[current_path] = (current_hash, current_version)
            current_path = None
            current_hash = None
            current_version = None
        elif line.startswith("domain_path:"):
            current_path = line.split(":", 1)[1].strip().strip('"')
        elif line.startswith("sha256:"):
            current_hash = line.split(":", 1)[1].strip().strip('"')
        elif line.startswith("file_version:"):
            current_version = line.split(":", 1)[1].strip().strip('"')
    if current_path and current_hash and current_version:
        versions[current_path] = (current_hash, current_version)
    return versions


def normalize_documents(source_dir, domain_root):
    copied = []
    for source_path in discover_source_files(source_dir):
        relative = source_path.relative_to(source_dir)
        suffix = ".md" if source_path.suffix.lower() == ".txt" else source_path.suffix
        target_name = relative.with_suffix(suffix).as_posix()
        target_path = domain_root / target_name
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if source_path.suffix.lower() == ".txt":
            content = source_path.read_text(encoding="utf-8", errors="ignore")
            target_path.write_text(f"# {source_path.stem}\n\n{content}", encoding="utf-8")
        else:
            shutil.copy2(source_path, target_path)
        copied.append(target_path)
    return copied


def build_index(output_root, domain, domain_root, version, documents, generated_at):
    existing_versions = read_existing_versions(domain_root / "index.yaml")
    rows = []
    changed = []
    sequence = 1
    for path in sorted(documents):
        domain_path = path.relative_to(domain_root).as_posix()
        full_path = Path("domains") / domain / domain_path
        digest = sha256(path)
        previous = existing_versions.get(domain_path)
        if previous and previous[0] == digest:
            file_version = previous[1]
        else:
            file_version = f"{version}_{sequence:03d}"
            sequence += 1
            changed.append(domain_path)
        rows.append(
            {
                "id": slugify(path.name),
                "path": full_path.as_posix(),
                "domain_path": domain_path,
                "title": title_for(path),
                "file_version": file_version,
                "sha256": digest,
                "size_bytes": path.stat().st_size,
                "updated_at": generated_at,
                "content_url": f"/api/knowledge/files?path={full_path.as_posix()}",
            }
        )
    return rows, changed


def write_root_manifest(output_root, domain, display_name):
    manifest_path = output_root / "manifest.yaml"
    if manifest_path.exists():
        return
    text = "\n".join(
        [
            "version: 1.0.0",
            "author: owenzhang",
            "status: clean_knowledge_pack",
            "canonical_root: doc/knowledge-pack",
            "rules:",
            "  default_write_root: doc/knowledge-pack",
            "  domain_root: doc/knowledge-pack/domains",
            "packs:",
            f"  - id: {domain}.doc_system",
            f"    display_name: {yaml_quote(display_name)}",
            f"    path: domains/{domain}",
            f"    manifest: domains/{domain}/manifest.yaml",
            "    status: available",
            "",
        ]
    )
    manifest_path.write_text(text, encoding="utf-8")


def write_domain_manifest(domain_root, domain, display_name, version, author, rows, generated_at):
    lines = [
        f"version: {version}",
        "status: domain_document_system",
        "copy_ready: true",
        f"author: {author}",
        f"domain: {domain}",
        f"display_name: {yaml_quote(display_name)}",
        f"slug: {domain}",
        "knowledge_base_root: doc/knowledge-pack",
        f"canonical_root: doc/knowledge-pack/domains/{domain}",
        f"updated_at: {yaml_quote(generated_at)}",
        "documents:",
    ]
    for row in rows:
        lines.extend(
            [
                f"  - id: {row['id']}",
                f"    path: {yaml_quote(row['domain_path'])}",
                "    role: domain_reference",
            ]
        )
    domain_root.joinpath("manifest.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_versions(domain_root, domain, version, author, source_note, changed, generated_at):
    lines = [
        f"domain: {domain}",
        f"current_version: {version}",
        f"updated_at: {yaml_quote(generated_at)}",
        f"author: {author}",
        "versions:",
        f"  - version: {version}",
        f"    updated_at: {yaml_quote(generated_at)}",
        f"    author: {author}",
        f"    source_note: {yaml_quote(source_note)}",
        "    changed_files:",
    ]
    lines.extend([f"      - {yaml_quote(item)}" for item in changed] or ["      - none"])
    domain_root.joinpath("versions.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_index(domain_root, domain, version, rows, generated_at):
    lines = [
        f"domain: {domain}",
        f"domain_version: {version}",
        f"generated_at: {yaml_quote(generated_at)}",
        "files:",
    ]
    for row in rows:
        lines.extend(
            [
                f"  - id: {row['id']}",
                f"    path: {yaml_quote(row['path'])}",
                f"    domain_path: {yaml_quote(row['domain_path'])}",
                f"    title: {yaml_quote(row['title'])}",
                f"    file_version: {row['file_version']}",
                f"    sha256: {row['sha256']}",
                f"    size_bytes: {row['size_bytes']}",
                f"    updated_at: {yaml_quote(row['updated_at'])}",
                f"    content_url: {yaml_quote(row['content_url'])}",
            ]
        )
    domain_root.joinpath("index.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def init_knowledge_pack(source_dir, output_root, domain, display_name, version, author, source_note):
    source_dir = Path(source_dir).expanduser().resolve()
    output_root = Path(output_root).expanduser().resolve()
    if ".codex/skills" in output_root.as_posix():
        raise ValueError("knowledge content must not be initialized under .codex/skills")
    domain = slugify(domain)
    generated_at = datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()
    domain_root = output_root / "domains" / domain
    domain_root.mkdir(parents=True, exist_ok=True)
    write_root_manifest(output_root, domain, display_name)
    documents = normalize_documents(source_dir, domain_root)
    rows, changed = build_index(output_root, domain, domain_root, version, documents, generated_at)
    write_domain_manifest(domain_root, domain, display_name, version, author, rows, generated_at)
    write_versions(domain_root, domain, version, author, source_note, changed, generated_at)
    write_index(domain_root, domain, version, rows, generated_at)
    return {
        "domain": domain,
        "version": version,
        "output_root": output_root.as_posix(),
        "domain_root": domain_root.as_posix(),
        "documents": len(rows),
        "changed_files": changed,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Initialize a versioned Warehouse Knowledge Pack domain.")
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--author", default="owenzhang")
    parser.add_argument("--source-note", default="knowledge pack initialization")
    args = parser.parse_args(argv)
    result = init_knowledge_pack(
        args.source_dir,
        args.output_root,
        args.domain,
        args.display_name,
        args.version,
        args.author,
        args.source_note,
    )
    print(
        "\n".join(
            [
                f"domain={result['domain']}",
                f"version={result['version']}",
                f"domain_root={result['domain_root']}",
                f"documents={result['documents']}",
                f"changed_files={len(result['changed_files'])}",
            ]
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
