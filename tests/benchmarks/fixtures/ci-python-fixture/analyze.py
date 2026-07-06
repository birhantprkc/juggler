#!/usr/bin/env python3
"""Simple Python script for testing execution."""

def count_words(text):
    """Count words in text."""
    return len(text.split())

def analyze_file(filename):
    """Analyze a file and return stats."""
    try:
        with open(filename, 'r') as f:
            content = f.read()
            lines = content.split('\n')
            words = count_words(content)
            return {
                'lines': len(lines),
                'words': words,
                'chars': len(content)
            }
    except FileNotFoundError:
        return {'error': f'File not found: {filename}'}

if __name__ == '__main__':
    print("Python execution test")
    print("Result:", analyze_file('sample.txt'))
