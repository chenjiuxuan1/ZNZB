#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker


DEFAULT_SEMANTIC_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO_ROOT = DEFAULT_SEMANTIC_ROOT.parent
DEFAULT_SHARED_SCHEMA = (
    DEFAULT_REPO_ROOT / "contracts" / "semantic" / "semantic-entity.schema.json"
)
SCHEMA_FILES = {
    "manifest": "schemas/manifest.schema.json",
    "metric": "schemas/metric.schema.json",
    "dimension": "schemas/dimension.schema.json",
    "segment": "schemas/segment.schema.json",
}
ENTITY_PATTERNS = (
    "metrics/**/*.yaml",
    "dimensions/*.yaml",
    "segments/*.yaml",
)


def _load_yaml(path, label, errors):
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        errors.append(f"{label}: cannot parse YAML: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{label}: expected a YAML mapping")
        return None
    return data


def _load_json(path, label, errors):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{label}: cannot parse JSON: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{label}: expected a JSON object")
        return None
    return data


def _json_path(error):
    parts = []
    for part in error.absolute_path:
        if isinstance(part, int):
            parts.append(f"[{part}]")
        elif parts:
            parts.append(f".{part}")
        else:
            parts.append(str(part))
    return "".join(parts) or "$"


def _validate(instance, schema, label, errors):
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    schema_errors = sorted(
        validator.iter_errors(instance),
        key=lambda item: repr(list(item.absolute_path)),
    )
    for error in schema_errors:
        errors.append(f"{label}:{_json_path(error)}: {error.message}")


def _is_within(path, root):
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _expected_path(entity):
    entity_id = entity.get("id")
    kind = entity.get("kind")
    if not isinstance(entity_id, str):
        return None
    if kind == "metric":
        parts = entity_id.split(".")
        if len(parts) != 2:
            return None
        return f"metrics/{parts[0]}/{parts[1]}.yaml"
    if kind == "dimension":
        return f"dimensions/{entity_id}.yaml"
    if kind == "segment":
        return f"segments/{entity_id}.yaml"
    return None


def _entity_files(root):
    files = set()
    for pattern in ENTITY_PATTERNS:
        files.update(
            path.relative_to(root).as_posix()
            for path in root.glob(pattern)
            if path.is_file()
        )
    return files


def validate_semantic_layer(
    semantic_root=DEFAULT_SEMANTIC_ROOT,
    shared_schema_path=DEFAULT_SHARED_SCHEMA,
):
    """Return a sorted list of semantic-layer validation errors."""
    root = Path(semantic_root).resolve()
    shared_schema_path = Path(shared_schema_path).resolve()
    errors = []

    schemas = {}
    for kind, relative_path in SCHEMA_FILES.items():
        schema_path = root / relative_path
        schema = _load_json(schema_path, relative_path, errors)
        if schema is not None:
            schemas[kind] = schema

    shared_schema = _load_json(
        shared_schema_path,
        shared_schema_path.as_posix(),
        errors,
    )
    manifest = _load_yaml(root / "manifest.yaml", "manifest.yaml", errors)
    if manifest is None or "manifest" not in schemas or shared_schema is None:
        return sorted(set(errors))

    _validate(manifest, schemas["manifest"], "manifest.yaml", errors)
    entries = manifest.get("entities")
    if not isinstance(entries, list):
        return sorted(set(errors))

    seen_ids = set()
    seen_paths = set()
    loaded_entities = {}
    manifest_paths = set()

    for index, entry in enumerate(entries):
        label = f"manifest.yaml:entities[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{label}: expected an object")
            continue

        entity_id = entry.get("id")
        relative_path = entry.get("path")
        kind = entry.get("kind")

        if entity_id in seen_ids:
            errors.append(f"{label}: duplicate manifest id {entity_id!r}")
        elif isinstance(entity_id, str):
            seen_ids.add(entity_id)

        if relative_path in seen_paths:
            errors.append(f"{label}: duplicate manifest path {relative_path!r}")
        elif isinstance(relative_path, str):
            seen_paths.add(relative_path)
            manifest_paths.add(relative_path)

        if not isinstance(relative_path, str):
            continue

        entity_path = (root / relative_path).resolve()
        if not _is_within(entity_path, root):
            errors.append(f"{label}: path escapes semantic-layer: {relative_path}")
            continue
        if not entity_path.is_file():
            errors.append(f"{label}: entity path does not exist: {relative_path}")
            continue

        entity = _load_yaml(entity_path, relative_path, errors)
        if entity is None:
            continue
        loaded_entities[relative_path] = entity

        if entity.get("kind") != kind:
            errors.append(
                f"{relative_path}: kind {entity.get('kind')!r} "
                f"does not match manifest kind {kind!r}"
            )
        if entity.get("id") != entity_id:
            errors.append(
                f"{relative_path}: id {entity.get('id')!r} "
                f"does not match manifest id {entity_id!r}"
            )
        if entity.get("name") != entry.get("display_name"):
            errors.append(
                f"{relative_path}: name does not match manifest display_name"
            )
        if entity.get("aliases") != entry.get("aliases"):
            errors.append(f"{relative_path}: aliases do not match manifest aliases")

        schema = schemas.get(kind)
        if schema is None:
            errors.append(f"{relative_path}: no schema registered for kind {kind!r}")
        else:
            _validate(entity, schema, relative_path, errors)

        shared_keys = shared_schema.get("properties", {}).keys()
        shared_projection = {
            key: entity[key] for key in shared_keys if key in entity
        }
        _validate(
            shared_projection,
            shared_schema,
            f"{relative_path}:shared-contract",
            errors,
        )

        expected_path = _expected_path(entity)
        if expected_path is not None and expected_path != relative_path:
            errors.append(
                f"{relative_path}: path does not match id; "
                f"expected {expected_path}"
            )

        expected_uri = f"semantic-layer/{relative_path}"
        actual_uri = entity.get("source", {}).get("uri")
        if actual_uri != expected_uri:
            errors.append(
                f"{relative_path}: source.uri must be {expected_uri!r}"
            )

    actual_paths = _entity_files(root)
    for relative_path in sorted(actual_paths - manifest_paths):
        errors.append(f"{relative_path}: entity is not registered in manifest")
    for relative_path in sorted(manifest_paths - actual_paths):
        errors.append(f"{relative_path}: manifest path is not an entity YAML")

    dimension_ids = {
        entity.get("id")
        for entity in loaded_entities.values()
        if entity.get("kind") == "dimension"
    }
    segment_ids = {
        entity.get("id")
        for entity in loaded_entities.values()
        if entity.get("kind") == "segment"
    }
    for relative_path, entity in loaded_entities.items():
        if entity.get("kind") != "metric":
            continue
        for dimension_id in entity.get("dimensions", []):
            if dimension_id not in dimension_ids:
                errors.append(
                    f"{relative_path}: unknown dimension {dimension_id!r}"
                )
        for segment_id in entity.get("segments", []):
            if segment_id not in segment_ids:
                errors.append(f"{relative_path}: unknown segment {segment_id!r}")

    return sorted(set(errors))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate Warehouse Agent semantic-layer schemas and seeds."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_SEMANTIC_ROOT,
        help="semantic-layer root directory",
    )
    parser.add_argument(
        "--shared-schema",
        type=Path,
        default=DEFAULT_SHARED_SCHEMA,
        help="frozen shared semantic contract",
    )
    args = parser.parse_args(argv)

    errors = validate_semantic_layer(args.root, args.shared_schema)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    manifest = yaml.safe_load(
        (args.root / "manifest.yaml").read_text(encoding="utf-8")
    )
    print(
        "semantic-layer validation passed: "
        f"{len(manifest['entities'])} entities"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
