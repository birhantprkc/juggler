#!/usr/bin/env python3
"""Script that intentionally has an error."""

def divide(a, b):
    return a / b

if __name__ == '__main__':
    print("Testing division by zero")
    result = divide(10, 0)  # This will raise ZeroDivisionError
    print(f"Result: {result}")
