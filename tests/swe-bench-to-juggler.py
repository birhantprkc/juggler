#!/usr/bin/env python3.11
"""
SWE-bench to Juggler Task Converter

Downloads SWE-bench Lite dataset and converts tasks to Juggler format.
Focus on simpler tasks from smaller repositories.

Usage:
    python tools/swe-bench-to-juggler.py --count 10 --output tests/benchmarks/tasks/swe-bench/
"""

import json
import os
import sys
import argparse
from pathlib import Path

try:
    from datasets import load_dataset
except ImportError:
    print("Error: 'datasets' package not found.")
    print("Install it with: pip install datasets")
    sys.exit(1)


# Repositories to prioritize (smaller, easier to work with)
PREFERRED_REPOS = [
    "psf/requests",
    "pallets/flask",
    "jakubroztocil/httpie",
    "pytest-dev/pytest",
    "sphinx-doc/sphinx",
]

# Difficulty mapping (approximate - based on repo size and complexity)
DIFFICULTY_MAP = {
    "psf/requests": "easy",
    "pallets/flask": "easy",
    "jakubroztocil/httpie": "easy",
    "pytest-dev/pytest": "medium",
    "sphinx-doc/sphinx": "medium",
    "django/django": "hard",
    "scikit-learn/scikit-learn": "hard",
    "sympy/sympy": "hard",
}


def convert_swebench_to_juggler(instance):
    """
    Convert a SWE-bench instance to Juggler task format.

    Args:
        instance: SWE-bench task instance (dict)

    Returns:
        dict: Juggler task format
    """
    instance_id = instance["instance_id"]
    repo = instance["repo"]

    # Extract repo name for fixture naming
    repo_name = repo.split("/")[-1]

    # Determine difficulty
    difficulty = DIFFICULTY_MAP.get(repo, "medium")

    # Parse FAIL_TO_PASS tests (JSON string to list)
    fail_to_pass = []
    if instance.get("FAIL_TO_PASS"):
        try:
            fail_to_pass = json.loads(instance["FAIL_TO_PASS"])
        except (json.JSONDecodeError, TypeError):
            fail_to_pass = []

    # Parse PASS_TO_PASS tests (JSON string to list)
    pass_to_pass = []
    if instance.get("PASS_TO_PASS"):
        try:
            pass_to_pass = json.loads(instance["PASS_TO_PASS"])
        except (json.JSONDecodeError, TypeError):
            pass_to_pass = []

    # Build the Juggler task
    task = {
        "id": f"swebench-{instance_id.replace('/', '-').replace('__', '-')}",
        "category": "swe-bench",
        "title": f"SWE-bench: {instance_id}",
        "description": f"Real-world GitHub issue from {repo}",

        "fixture": {
            "type": "git",
            "repo_url": f"https://github.com/{repo}.git",
            "base_commit": instance["base_commit"],
            "install_commands": [
                "python -m pip install -e .",
            ]
        },

        "prompt": build_prompt(instance),

        "scoring": {
            "type": "swe_bench_validation",
            "fail_to_pass": fail_to_pass,
            "pass_to_pass": pass_to_pass,
            "test_command": "python -m pytest {test_path} -xvs",
            "timeout": 300
        },

        "metadata": {
            "source": "SWE-bench Lite",
            "difficulty": difficulty,
            "original_instance_id": instance_id,
            "repo": repo,
            "issue_id": instance.get("issue_id"),
            "created_at": instance.get("created_at"),
        }
    }

    return task


def build_prompt(instance):
    """
    Build the prompt for the AI from the SWE-bench instance.

    Combines problem statement with optional hints.
    """
    prompt_parts = []

    # Add problem statement
    problem = instance.get("problem_statement", "")
    if problem:
        prompt_parts.append(f"**Problem Statement:**\n\n{problem}")

    # Add hints from issue comments if available
    hints = instance.get("hints_text", "")
    if hints:
        prompt_parts.append(f"\n\n**Hints from Issue Discussion:**\n\n{hints}")

    # Add links for reference
    if instance.get("issue_url"):
        prompt_parts.append(f"\n\n**Original Issue:** {instance['issue_url']}")

    return "\n".join(prompt_parts)


def filter_instances(dataset, max_count=10, preferred_repos=None):
    """
    Filter SWE-bench instances to get a good starter set.

    Prioritizes:
    - Preferred repositories (smaller, easier)
    - Tasks with both fail_to_pass and pass_to_pass tests
    - Shorter problem statements (simpler issues)

    Args:
        dataset: SWE-bench dataset
        max_count: Maximum number of tasks to return
        preferred_repos: List of preferred repo names

    Returns:
        list: Filtered instances
    """
    if preferred_repos is None:
        preferred_repos = PREFERRED_REPOS

    # First pass: collect tasks from preferred repos
    preferred_tasks = []
    other_tasks = []

    for instance in dataset:
        repo = instance["repo"]

        # Skip if missing critical data
        if not instance.get("base_commit") or not instance.get("problem_statement"):
            continue

        # Skip if no tests defined
        fail_to_pass = instance.get("FAIL_TO_PASS", "[]")
        pass_to_pass = instance.get("PASS_TO_PASS", "[]")
        if fail_to_pass == "[]" and pass_to_pass == "[]":
            continue

        # Categorize
        if repo in preferred_repos:
            preferred_tasks.append(instance)
        else:
            other_tasks.append(instance)

    # Sort preferred tasks by problem statement length (simpler first)
    preferred_tasks.sort(key=lambda x: len(x.get("problem_statement", "")))

    # Take from preferred repos first, then others if needed
    selected = preferred_tasks[:max_count]
    if len(selected) < max_count:
        other_tasks.sort(key=lambda x: len(x.get("problem_statement", "")))
        selected.extend(other_tasks[:max_count - len(selected)])

    return selected[:max_count]


def main():
    parser = argparse.ArgumentParser(
        description="Convert SWE-bench tasks to Juggler format"
    )
    parser.add_argument(
        "--count",
        type=int,
        default=10,
        help="Number of tasks to convert (default: 10)"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="tests/benchmarks/tasks/swe-bench",
        help="Output directory for task JSONs (default: tests/benchmarks/tasks/swe-bench)"
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default="princeton-nlp/SWE-bench_Lite",
        help="SWE-bench dataset to use (default: SWE-bench_Lite)"
    )
    parser.add_argument(
        "--split",
        type=str,
        default="test",
        help="Dataset split to use (default: test)"
    )

    args = parser.parse_args()

    print(f"📥 Loading {args.dataset} dataset...")
    try:
        dataset = load_dataset(args.dataset, split=args.split)
    except Exception as e:
        print(f"❌ Failed to load dataset: {e}")
        print("\nMake sure you have internet connection and the 'datasets' package installed:")
        print("  pip install datasets")
        sys.exit(1)

    print(f"✅ Loaded {len(dataset)} tasks from {args.dataset}")

    print(f"\n🔍 Filtering to get {args.count} starter tasks...")
    selected = filter_instances(dataset, max_count=args.count)
    print(f"✅ Selected {len(selected)} tasks")

    # Show selected repos
    repos = {}
    for instance in selected:
        repo = instance["repo"]
        repos[repo] = repos.get(repo, 0) + 1

    print("\n📊 Selected tasks by repository:")
    for repo, count in sorted(repos.items(), key=lambda x: -x[1]):
        difficulty = DIFFICULTY_MAP.get(repo, "medium")
        print(f"  - {repo}: {count} tasks ({difficulty})")

    # Create output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n💾 Converting and saving to {output_dir}/")

    converted_count = 0
    for instance in selected:
        try:
            task = convert_swebench_to_juggler(instance)

            # Save to file
            task_id = task["id"]
            output_file = output_dir / f"{task_id}.json"

            with open(output_file, "w") as f:
                json.dump(task, f, indent=2)

            print(f"  ✅ {task_id}")
            converted_count += 1

        except Exception as e:
            instance_id = instance.get("instance_id", "unknown")
            print(f"  ❌ Failed to convert {instance_id}: {e}")

    print(f"\n✅ Successfully converted {converted_count}/{len(selected)} tasks")
    print(f"\n📁 Task files saved to: {output_dir}")
    print(f"\nNext steps:")
    print(f"  1. Review the generated task files")
    print(f"  2. Run: make benchmark")
    print(f"  3. Monitor progress and fix any issues")


if __name__ == "__main__":
    main()
