import json
import re
from pathlib import Path
from typing import Any


FUEL_KEY_PATTERN = re.compile(r"^fuel-(\d+)$")


def parse_number(value: Any) -> float:
	if isinstance(value, bool):
		return float(int(value))
	if isinstance(value, (int, float)):
		return float(value)
	if isinstance(value, str):
		try:
			return float(value.strip())
		except ValueError:
			return 0.0
	return 0.0


def compute_total_fuel(entry: dict[str, Any]) -> int | float:
	total = 0.0

	for key, value in entry.items():
		match = FUEL_KEY_PATTERN.match(key)
		if not match:
			continue

		fuel_value = int(match.group(1))
		quantity = parse_number(value)
		total += fuel_value * quantity

	return int(total) if total.is_integer() else total


def add_total_fuel(entries: list[dict[str, Any]]) -> None:
	for entry in entries:
		entry["total-fuel"] = compute_total_fuel(entry)


def main() -> None:
	data_path = Path(__file__).resolve().parent.parent / "data.json"

	with data_path.open("r", encoding="utf-8") as file:
		data = json.load(file)

	if isinstance(data, list):
		add_total_fuel([entry for entry in data if isinstance(entry, dict)])
	elif isinstance(data, dict):
		for value in data.values():
			if isinstance(value, list):
				add_total_fuel([entry for entry in value if isinstance(entry, dict)])

	with data_path.open("w", encoding="utf-8") as file:
		json.dump(data, file, indent=2)
		file.write("\n")


if __name__ == "__main__":
	main()
