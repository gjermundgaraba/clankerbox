import os
import unittest
from calculator import transform


class TransformTest(unittest.TestCase):
    def test_branch_formula(self):
        slope = int(os.environ.get('EXPECT_SLOPE', '1'))
        offset = int(os.environ.get('EXPECT_OFFSET', '0'))
        for value in (-5, 0, 7):
            self.assertEqual(transform(value), slope * value + offset)


if __name__ == '__main__':
    unittest.main()
